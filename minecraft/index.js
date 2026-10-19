// ─── Minecraft modpack (Electron side) ───────────────────────────────────────
// Wires the modpack service to the app: real paths, network policy, the
// store, shell.openPath (hands the .mrpack to Modrinth App), events to the
// site, automatic update checks, and the aniverse://minecraft deep link the
// in-game update mod opens.
//
// Automatic updates: a check shortly after start and every
// config.MINECRAFT.CHECK_INTERVAL; an install with a new version is updated
// at once when Minecraft is not running from it, otherwise as soon as the
// game is closed (polled every few minutes).

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { app, shell } = require("electron");
const config = require("../config");
const { createModpackService } = require("./service");
const { createFetch } = require("./net");
const { errorCode } = require("./errors");
const { sleep } = require("./download");
const { ensureJava, requiredJavaMajor, MOJANG_HOSTS } = require("./java");
const { systemEnv, run, spawnDetached, isGameRunning } = require("./system");
const official = require("./launchers/official");
const modrinth = require("./launchers/modrinth");
const prism = require("./launchers/prism");

const STORE_KEY = "minecraft.installs";
const FIRST_CHECK_DELAY_MS = 20_000;
const PENDING_POLL_MS = 3 * 60_000;
const DEEP_LINK_WAIT_MS = 10 * 60_000;

const HOSTS = [
  "raw.githubusercontent.com",
  "github.com",
  "objects.githubusercontent.com",
  "media.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "cdn.modrinth.com",
  "maven.neoforged.net",
  "meta.fabricmc.net",
  ...MOJANG_HOSTS,
];

let service = null;
let send = () => {};
let checkTimer = null;
let pendingTimer = null;
const pending = new Set(); // installIds waiting for their game to close

// Progress at most ~8 times a second; the last event of a phase always goes out.
function throttled(fn, ms = 125) {
  let last = 0;
  let queued = null;
  let timer = null;
  return (p) => {
    const urgent = p.phase === "done" || (p.total > 0 && p.done === p.total);
    const fire = () => {
      timer = null;
      last = Date.now();
      fn(queued);
      queued = null;
    };
    queued = p;
    if (urgent || Date.now() - last >= ms) {
      clearTimeout(timer);
      fire();
    } else if (!timer) {
      timer = setTimeout(fire, ms - (Date.now() - last));
    }
  };
}

function manifestSource() {
  const cfg = config.MINECRAFT;
  // Dev / test override (a local folder served over http): ignored in installed builds.
  const override = !app.isPackaged ? process.env.ANIVERSE_MODPACK_URL : null;
  if (override) return { manifestUrl: override };
  if (cfg.MANIFEST_URL) return { manifestUrl: cfg.MANIFEST_URL };
  return { repo: cfg.REPO };
}

function iconDataUrl() {
  try {
    const png = fs.readFileSync(path.join(__dirname, "..", "assets", "icons", "transparant", "128.png"));
    return `data:image/png;base64,${png.toString("base64")}`;
  } catch (_) {
    return undefined;
  }
}

/** { ok: true, data } | { ok: false, error, message }: errors survive IPC as codes. */
async function result(fn) {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    return { ok: false, error: errorCode(err), message: err?.message || String(err) };
  }
}

// ── Automatic updates ─────────────────────────────────────────────────────────
async function autoUpdate() {
  if (!service || service.status().busy) return;
  try {
    const { installs } = await service.check();
    for (const install of installs) {
      if (!install.updateAvailable) continue;
      if (await isGameRunning(install.gameDir)) {
        pending.add(install.installId);
        continue;
      }
      pending.delete(install.installId);
      await service.update(install.installId).catch((err) => console.warn("[minecraft] auto update failed:", err.message));
    }
  } catch (err) {
    console.warn("[minecraft] update check failed:", err.message);
  }
}

async function retryPending() {
  if (!service || pending.size === 0 || service.status().busy) return;
  const installs = await service.installs().catch(() => []);
  for (const id of [...pending]) {
    const install = installs.find((i) => i.installId === id);
    if (!install) {
      pending.delete(id);
      continue;
    }
    if (await isGameRunning(install.gameDir)) continue;
    pending.delete(id);
    await service.update(id).catch((err) => console.warn("[minecraft] pending update failed:", err.message));
  }
}

// ── Deep link: aniverse://minecraft/update?install=<installId> ────────────────
// Opened by the in-game update mod: the game is closing, so wait for it, then update.
function handleDeepLink(url) {
  if (!service) return false;
  const action = url.pathname.replace(/^\/+/, "");
  if (action !== "update") return false;
  const installId = url.searchParams.get("install");
  if (installId && !/^[A-Za-z0-9-]{1,64}$/.test(installId)) return false;
  send("minecraft:update-requested", { installId: installId || null });
  const deadline = Date.now() + DEEP_LINK_WAIT_MS;
  (async () => {
    // An automatic update may be running already: let it finish, then check again.
    while (service.status().busy && Date.now() < deadline) await sleep(2000);
    return service.update(installId || undefined, { waitForGameMs: Math.max(0, deadline - Date.now()) });
  })()
    .then((r) => send("minecraft:update-finished", { ok: true, ...r }))
    .catch((err) => send("minecraft:update-finished", { ok: false, error: errorCode(err), message: err.message }));
  return true;
}

function initMinecraft({ store, sendToApp }) {
  send = sendToApp;
  const source = manifestSource();
  const hosts = new Set(HOSTS);
  let allowLoopbackHttp = false;
  if (source.manifestUrl) {
    const u = new URL(source.manifestUrl);
    hosts.add(u.hostname.toLowerCase());
    allowLoopbackHttp = !app.isPackaged && u.protocol === "http:";
  }
  const guardedFetch = createFetch({ hosts, allowLoopbackHttp });
  const sys = systemEnv();
  const runtimeDir = path.join(app.getPath("userData"), "minecraft", "runtime");
  const emitProgress = throttled((p) => send("minecraft:progress", p));

  service = createModpackService({
    source,
    sys,
    launchers: { official, modrinth, prism },
    guardedFetch,
    store: { get: () => store.get(STORE_KEY, []), set: (v) => store.set(STORE_KEY, v) },
    openFile: (file) => shell.openPath(file),
    runImpl: run,
    // Launchers started by "Lancer Minecraft" outlive the app
    startProgram: spawnDetached,
    isGameRunning: (gameDir) => isGameRunning(gameDir),
    ensureJava: (mcVersion, { signal, onProgress }) =>
      ensureJava(sys, { major: requiredJavaMajor(mcVersion), ownRuntimeDir: runtimeDir, guardedFetch, signal, onProgress }),
    tmpDir: path.join(app.getPath("temp"), "aniverse-modpack"),
    newId: () => crypto.randomUUID(),
    options: {
      instanceName: config.MINECRAFT.INSTANCE_NAME,
      memoryMB: config.MINECRAFT.MEMORY_MB,
      iconDataUrl: iconDataUrl(),
    },
    onProgress: emitProgress,
    onStatus: (s) => send("minecraft:status", s),
  });

  setTimeout(autoUpdate, FIRST_CHECK_DELAY_MS).unref?.();
  checkTimer = setInterval(autoUpdate, config.MINECRAFT.CHECK_INTERVAL);
  pendingTimer = setInterval(retryPending, PENDING_POLL_MS);

  return {
    // Launchers found here, each with the pack's install in it (or null)
    detect: () => result(() => service.detect()),
    installs: () => result(() => service.installs()),
    check: () => result(() => service.check()),
    // { launcher: "official" | "modrinth" | "prism", dataDir? } (dataDir from detect when a launcher has several)
    install: (target) => result(() => service.install(target || {})),
    // installId, or none for every install; { verify: true } re-hashes every file
    update: (installId, opts) =>
      result(() => service.update(typeof installId === "string" ? installId : undefined, { verify: opts?.verify === true })),
    // Starts the game (Prism Launcher) or opens the install's launcher: { opened: "game" | "launcher", launcherName }
    launch: (installId) => result(() => service.launch(typeof installId === "string" ? installId : "")),
    cancel: () => service.cancel(),
    status: () => service.status(),
    handleDeepLink,
    stop() {
      clearInterval(checkTimer);
      clearInterval(pendingTimer);
      service?.cancel();
    },
  };
}

module.exports = { initMinecraft };
