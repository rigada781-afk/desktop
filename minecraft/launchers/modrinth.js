// ─── Modrinth App ────────────────────────────────────────────────────────────
// Modrinth App keeps its instances in a SQLite database whose schema changes
// between releases, so the instance is created by Modrinth App itself: we hand
// it a small .mrpack (Minecraft + loader versions, and our marker as an
// override), the player confirms the import there, and we find the new
// profile folder by its marker. From then on the files are ours to sync like
// any other install; Modrinth App picks up file changes in its folders.
// A later loader version change cannot be applied from outside: it is
// reported, and the player reinstalls.

const fs = require("fs");
const path = require("path");
const { ModpackError } = require("../errors");
const { sleep } = require("../download");
const { MARKER_FILE, readMarker, subdirs } = require("../marker");
const { exists, startFirst } = require("../system");
const { createZip } = require("../zip");

const ID = "modrinth";
const DEPENDENCY = { neoforge: "neoforge", forge: "forge", fabric: "fabric-loader", quilt: "quilt-loader" };

function dataDirs(sys) {
  if (sys.platform === "win32") {
    return [path.join(sys.appData, "ModrinthApp"), path.join(sys.appData, "com.modrinth.theseus")];
  }
  if (sys.platform === "darwin") {
    return [path.join(sys.macSupport, "ModrinthApp"), path.join(sys.macSupport, "com.modrinth.theseus")];
  }
  return [
    path.join(sys.xdgData, "ModrinthApp"),
    path.join(sys.xdgData, "com.modrinth.theseus"),
    path.join(sys.home, ".var", "app", "com.modrinth.ModrinthApp", "data", "ModrinthApp"),
  ];
}

async function detect(sys) {
  const out = [];
  for (const dataDir of dataDirs(sys)) {
    if ((await exists(path.join(dataDir, "app.db"))) || (await exists(path.join(dataDir, "profiles")))) out.push({ dataDir });
  }
  return out;
}

async function findInstalls(dataDir) {
  const root = path.join(dataDir, "profiles");
  const out = [];
  for (const name of await subdirs(root)) {
    if (await readMarker(path.join(root, name))) out.push(path.join(root, name));
  }
  return out;
}

const loaderSupported = () => true;

/** A .mrpack with no files: Modrinth App creates the instance and installs the loader; we sync the files. */
function buildMrpack(manifest, { name, installId, summary }) {
  const dependencies = { minecraft: manifest.minecraft };
  const key = DEPENDENCY[manifest.loader.type];
  if (key) dependencies[key] = manifest.loader.version;
  const index = {
    formatVersion: 1,
    game: "minecraft",
    versionId: manifest.version,
    name,
    summary: summary || `${name} modpack`,
    files: [],
    dependencies,
  };
  const marker = { format: 1, installId, name, launcher: ID, version: null };
  return createZip([
    { name: "modrinth.index.json", data: JSON.stringify(index, null, 2) },
    { name: `overrides/${MARKER_FILE}`, data: JSON.stringify(marker, null, 2) },
  ]);
}

/** Polls the profiles folder until the instance carrying installId appears. */
async function waitForProfile(dataDir, installId, { signal, timeoutMs, intervalMs = 2000 }) {
  const root = path.join(dataDir, "profiles");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const name of await subdirs(root)) {
      const marker = await readMarker(path.join(root, name));
      if (marker?.installId === installId) return { gameDir: path.join(root, name), ref: name };
    }
    if (Date.now() > deadline) throw new ModpackError("install-timeout", "the instance was not created in Modrinth App");
    await sleep(intervalMs, signal);
  }
}

async function install(ctx) {
  const file = path.join(ctx.tmpDir, `${ctx.instanceName.replace(/[^A-Za-z0-9 _-]/g, "") || "Aniverse"}.mrpack`);
  await fs.promises.mkdir(ctx.tmpDir, { recursive: true });
  await fs.promises.writeFile(file, buildMrpack(ctx.manifest, { name: ctx.instanceName, installId: ctx.installId }));
  ctx.onProgress?.({ phase: "waiting-launcher", done: 0, total: 1, bytesDone: 0, bytesTotal: 0 });
  // Opens with the app registered for .mrpack (Modrinth App): the player confirms the import there.
  const error = await ctx.openFile(file);
  if (error) throw new ModpackError("launcher-not-found", `could not open the .mrpack: ${error}`);
  try {
    return await waitForProfile(ctx.dataDir, ctx.installId, { signal: ctx.signal, timeoutMs: ctx.installTimeoutMs });
  } finally {
    await fs.promises.rm(file, { force: true }).catch(() => {});
  }
}

async function updateLoader() {
  return { ok: false, reason: "reinstall" };
}

/** Where Modrinth App's program is, most likely first: { cmd, args, requires } for startFirst. */
function programs(sys, dataDir) {
  if (sys.platform === "win32") {
    const programFiles = sys.env.ProgramFiles || "C:\\Program Files";
    return [
      path.join(sys.localAppData, "Modrinth App", "Modrinth App.exe"),
      path.join(sys.localAppData, "Programs", "Modrinth App", "Modrinth App.exe"),
      path.join(programFiles, "Modrinth App", "Modrinth App.exe"),
    ].map((cmd) => ({ cmd }));
  }
  if (sys.platform === "darwin") {
    const app = "/Applications/Modrinth App.app";
    return [{ cmd: "open", args: ["-a", app], requires: app }];
  }
  if (dataDir.includes(path.join(".var", "app", "com.modrinth.ModrinthApp"))) {
    return [{ cmd: "flatpak", args: ["run", "com.modrinth.ModrinthApp"] }];
  }
  return [{ cmd: "modrinth-app" }, { cmd: "ModrinthApp" }];
}

/** Modrinth App can't start a profile from outside: it opens, and the player presses Play on "Aniverse". */
async function launch(record, { sys, start }) {
  if (!(await startFirst(programs(sys, record.dataDir), start))) {
    throw new ModpackError("launcher-not-found", "Modrinth App's program was not found");
  }
  return { opened: "launcher" };
}

module.exports = {
  id: ID,
  name: "Modrinth App",
  dataDirs,
  detect,
  findInstalls,
  loaderSupported,
  buildMrpack,
  waitForProfile,
  install,
  updateLoader,
  programs,
  launch,
};
