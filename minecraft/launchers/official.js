// ─── Official Minecraft Launcher ─────────────────────────────────────────────
// The pack gets its own game directory (<.minecraft>/modpacks/aniverse, the
// layout CurseForge uses too) and its own profile in launcher_profiles.json.
// The loader version is installed into <.minecraft>/versions: NeoForge by
// running its installer (needs Java), Fabric from its profile JSON, vanilla
// is downloaded by the launcher itself.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { ModpackError } = require("../errors");
const { downloadFile } = require("../download");
const { getText } = require("../net");
const { readMarker } = require("../marker");
const { readJson } = require("../sync");
const { exists, startFirst } = require("../system");

const ID = "official";
const PROFILE_ID = "aniverse";
const PROFILES_FILE = "launcher_profiles.json";
const SUPPORTED = new Set(["vanilla", "neoforge", "fabric"]);
const DEFAULT_JVM = "-XX:+UnlockExperimentalVMOptions -XX:+UseG1GC -XX:G1NewSizePercent=20 -XX:G1ReservePercent=20 -XX:MaxGCPauseMillis=50 -XX:G1HeapRegionSize=32M";

function dataDirs(sys) {
  if (sys.platform === "win32") return [path.join(sys.appData, ".minecraft")];
  if (sys.platform === "darwin") return [path.join(sys.macSupport, "minecraft")];
  return [path.join(sys.home, ".minecraft"), path.join(sys.home, ".var", "app", "com.mojang.Minecraft", ".minecraft")];
}

/** Data dirs with a launcher_profiles.json (the launcher has run there at least once). */
async function detect(sys) {
  const out = [];
  for (const dataDir of dataDirs(sys)) if (await exists(path.join(dataDir, PROFILES_FILE))) out.push({ dataDir });
  return out;
}

const gameDirFor = (dataDir) => path.join(dataDir, "modpacks", "aniverse");

async function findInstalls(dataDir) {
  const gameDir = gameDirFor(dataDir);
  return (await readMarker(gameDir)) ? [gameDir] : [];
}

const loaderSupported = (manifest) => SUPPORTED.has(manifest.loader.type);

function versionIdFor(manifest) {
  const { type, version } = manifest.loader;
  if (type === "neoforge") return `neoforge-${version}`;
  if (type === "fabric") return `fabric-loader-${version}-${manifest.minecraft}`;
  return manifest.minecraft;
}

async function readProfiles(dataDir) {
  const file = path.join(dataDir, PROFILES_FILE);
  const raw = await readJson(file);
  if (!raw || typeof raw !== "object") throw new ModpackError("launcher-not-found", `${PROFILES_FILE} is missing or unreadable`);
  if (!raw.profiles || typeof raw.profiles !== "object") raw.profiles = {};
  return raw;
}

/** Rewrites launcher_profiles.json, keeping everything we do not own. */
async function writeProfiles(dataDir, raw) {
  const file = path.join(dataDir, PROFILES_FILE);
  const text = JSON.stringify(raw, null, 2);
  const tmp = `${file}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  await fs.promises.writeFile(tmp, text);
  try {
    await fs.promises.rename(tmp, file);
  } catch (_) {
    // The launcher can hold the file open: write in place instead.
    await fs.promises.rm(tmp, { force: true });
    await fs.promises.writeFile(file, text);
  }
}

async function installNeoForge(ctx, versionId) {
  const { manifest, dataDir, signal } = ctx;
  const v = manifest.loader.version;
  const url = `https://maven.neoforged.net/releases/net/neoforged/neoforge/${v}/neoforge-${v}-installer.jar`;
  ctx.onProgress?.({ phase: "loader", done: 0, total: 1, bytesDone: 0, bytesTotal: 0 });
  // The installer runs as code: only with the sha1 pinned in the manifest or the one NeoForge's Maven publishes.
  let sha1 = manifest.loader.installer_sha1;
  if (!sha1) {
    sha1 = (await getText(ctx.guardedFetch, `${url}.sha1`, { signal, maxBytes: 1024 }).catch((err) => {
      throw err.code === "offline" ? err : new ModpackError("loader-failed", `NeoForge ${v} not found`);
    }))
      .trim()
      .split(/\s+/)[0]
      .toLowerCase();
    if (!/^[a-f0-9]{40}$/.test(sha1)) throw new ModpackError("loader-failed", "bad NeoForge installer hash");
  }
  const work = path.join(ctx.tmpDir, `neoforge-${v}`);
  await fs.promises.mkdir(work, { recursive: true });
  const jar = path.join(work, "installer.jar");
  const res = await ctx.guardedFetch(url, { signal, method: "HEAD" }).catch(() => null);
  const size = Number(res?.headers.get("content-length")) || null;
  if (!size) throw new ModpackError("offline", "NeoForge installer size unknown");
  await downloadFile({ id: "neoforge-installer", url, dest: jar, part: `${jar}.part`, size, sha1 }, { fetch: ctx.guardedFetch, signal });

  const java = await ctx.javaFor(manifest.minecraft);
  const before = new Set(Object.keys((await readProfiles(dataDir)).profiles));
  ctx.onProgress?.({ phase: "loader", done: 0, total: 1, bytesDone: 0, bytesTotal: 0 });
  const r = await ctx.runImpl(java, ["-jar", jar, "--install-client", dataDir], { cwd: work, signal, timeoutMs: 20 * 60_000 });
  const json = path.join(dataDir, "versions", versionId, `${versionId}.json`);
  if (r.code !== 0 || !(await exists(json))) {
    const tail = `${r.stdout}\n${r.stderr}`.trim().split(/\r?\n/).slice(-5).join(" | ");
    throw new ModpackError("loader-failed", `NeoForge installer exited with ${r.code}: ${tail}`);
  }
  // The installer adds its own "NeoForge" profile on the main .minecraft folder: the pack has ours.
  const raw = await readProfiles(dataDir);
  for (const [key, p] of Object.entries(raw.profiles)) {
    if (!before.has(key) && key !== PROFILE_ID && p?.lastVersionId === versionId) delete raw.profiles[key];
  }
  await writeProfiles(dataDir, raw);
  await fs.promises.rm(work, { recursive: true, force: true });
}

async function installFabric(ctx, versionId) {
  const { manifest, dataDir, signal } = ctx;
  const url = `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(manifest.minecraft)}/${encodeURIComponent(manifest.loader.version)}/profile/json`;
  const text = await getText(ctx.guardedFetch, url, { signal, maxBytes: 1024 * 1024 });
  const profile = JSON.parse(text);
  if (profile?.id !== versionId) throw new ModpackError("loader-failed", `unexpected Fabric profile ${profile?.id}`);
  const dir = path.join(dataDir, "versions", versionId);
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(path.join(dir, `${versionId}.json`), text);
}

/** The loader version installed into <.minecraft>/versions → its version id. */
async function ensureVersion(ctx) {
  const { manifest, dataDir } = ctx;
  if (!loaderSupported(manifest)) throw new ModpackError("loader-unsupported", `${manifest.loader.type} on the official launcher`);
  const versionId = versionIdFor(manifest);
  if (manifest.loader.type === "vanilla") return versionId;
  if (await exists(path.join(dataDir, "versions", versionId, `${versionId}.json`))) return versionId;
  if (manifest.loader.type === "neoforge") await installNeoForge(ctx, versionId);
  else await installFabric(ctx, versionId);
  return versionId;
}

async function writeProfile(ctx, versionId, gameDir) {
  const raw = await readProfiles(ctx.dataDir);
  const prev = raw.profiles[PROFILE_ID] || {};
  const now = new Date().toISOString();
  raw.profiles[PROFILE_ID] = {
    ...prev, // the player's own tweaks (memory, resolution, icon) survive updates
    name: ctx.instanceName,
    type: "custom",
    created: prev.created || now,
    lastUsed: prev.lastUsed || now,
    icon: prev.icon || ctx.iconDataUrl || "Furnace",
    lastVersionId: versionId,
    gameDir,
    javaArgs: prev.javaArgs || `-Xmx${Math.round(ctx.memoryMB / 1024)}G ${DEFAULT_JVM}`,
  };
  await writeProfiles(ctx.dataDir, raw);
}

async function install(ctx) {
  const versionId = await ensureVersion(ctx);
  const gameDir = gameDirFor(ctx.dataDir);
  await fs.promises.mkdir(gameDir, { recursive: true });
  await writeProfile(ctx, versionId, gameDir);
  return { gameDir, ref: PROFILE_ID };
}

/** New Minecraft / loader version: install it and point the profile at it. */
async function updateLoader(record, ctx) {
  const versionId = await ensureVersion(ctx);
  await writeProfile(ctx, versionId, record.gameDir);
  return { ok: true };
}

// The Microsoft Store / Xbox app's Minecraft Launcher (a packaged app: started through the shell).
const STORE_PACKAGE = "Microsoft.4297127D64EC6_8wekyb3d8bbwe";

/** Where the launcher's program is, most likely first: { cmd, args, requires } for startFirst. */
function programs(sys, dataDir) {
  if (sys.platform === "win32") {
    const env = sys.env;
    const windows = env.SystemRoot || env.windir || "C:\\Windows";
    return [
      { cmd: path.join(env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Minecraft Launcher", "MinecraftLauncher.exe") },
      { cmd: path.join(env.ProgramFiles || "C:\\Program Files", "Minecraft Launcher", "MinecraftLauncher.exe") },
      {
        cmd: path.join(windows, "explorer.exe"),
        args: [`shell:AppsFolder\\${STORE_PACKAGE}!Minecraft`],
        requires: path.join(sys.localAppData, "Packages", STORE_PACKAGE),
      },
    ];
  }
  if (sys.platform === "darwin") {
    const app = "/Applications/Minecraft.app";
    return [{ cmd: "open", args: ["-a", app], requires: app }];
  }
  if (dataDir.includes(path.join(".var", "app", "com.mojang.Minecraft"))) {
    return [{ cmd: "flatpak", args: ["run", "com.mojang.Minecraft"] }];
  }
  return [{ cmd: "minecraft-launcher" }];
}

/**
 * The launcher can't start a profile from outside: the pack's profile becomes the last used one (the
 * launcher selects it), then the launcher opens and the player presses Play.
 */
async function launch(record, { sys, start }) {
  const raw = await readProfiles(record.dataDir).catch(() => null);
  if (raw?.profiles[PROFILE_ID]) {
    raw.profiles[PROFILE_ID].lastUsed = new Date().toISOString();
    await writeProfiles(record.dataDir, raw).catch(() => {});
  }
  if (!(await startFirst(programs(sys, record.dataDir), start))) {
    throw new ModpackError("launcher-not-found", "the Minecraft Launcher's program was not found");
  }
  return { opened: "launcher" };
}

module.exports = {
  id: ID,
  name: "Minecraft Launcher",
  PROFILE_ID,
  dataDirs,
  detect,
  findInstalls,
  loaderSupported,
  versionIdFor,
  ensureVersion,
  install,
  updateLoader,
  programs,
  launch,
};
