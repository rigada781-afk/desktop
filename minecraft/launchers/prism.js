// ─── Prism Launcher ──────────────────────────────────────────────────────────
// An instance is a folder with instance.cfg + mmc-pack.json (the components:
// Minecraft and the loader, which Prism downloads at launch) and the game
// directory in minecraft/. Everything is plain files, so install and loader
// updates are written directly. Prism lists a new instance folder after a
// restart (or at once when its file watcher sees it).

const fs = require("fs");
const path = require("path");
const { ModpackError } = require("../errors");
const { readMarker, subdirs } = require("../marker");
const { readJson, writeJsonAtomic } = require("../sync");
const { exists, startFirst } = require("../system");

const ID = "prism";
const CONFIG = "prismlauncher.cfg";
const LOADER_UIDS = {
  neoforge: "net.neoforged",
  forge: "net.minecraftforge",
  fabric: "net.fabricmc.fabric-loader",
  quilt: "org.quiltmc.quilt-loader",
};
const ALL_LOADER_UIDS = new Set(Object.values(LOADER_UIDS));

function dataDirs(sys) {
  if (sys.platform === "win32") return [path.join(sys.appData, "PrismLauncher")];
  if (sys.platform === "darwin") return [path.join(sys.macSupport, "PrismLauncher")];
  return [
    path.join(sys.xdgData, "PrismLauncher"),
    path.join(sys.home, ".var", "app", "org.prismlauncher.PrismLauncher", "data", "PrismLauncher"),
  ];
}

async function detect(sys) {
  const out = [];
  for (const dataDir of dataDirs(sys)) if (await exists(path.join(dataDir, CONFIG))) out.push({ dataDir });
  return out;
}

/** The instances folder: InstanceDir in prismlauncher.cfg (absolute or relative to the data dir). */
async function instancesDir(dataDir) {
  const text = await fs.promises.readFile(path.join(dataDir, CONFIG), "utf8").catch(() => "");
  const line = text.split(/\r?\n/).find((l) => /^InstanceDir\s*=/.test(l));
  const value = line ? line.slice(line.indexOf("=") + 1).trim() : "";
  if (!value) return path.join(dataDir, "instances");
  return path.isAbsolute(value) ? value : path.join(dataDir, value);
}

/** Prism uses minecraft/, or .minecraft/ in instances that only have that one. */
async function gameDirOf(instanceDir) {
  const dot = path.join(instanceDir, ".minecraft");
  const plain = path.join(instanceDir, "minecraft");
  return (await exists(dot)) && !(await exists(plain)) ? dot : plain;
}

async function findInstalls(dataDir) {
  const root = await instancesDir(dataDir);
  const out = [];
  for (const name of await subdirs(root)) {
    const gameDir = await gameDirOf(path.join(root, name));
    if (await readMarker(gameDir)) out.push(gameDir);
  }
  return out;
}

const loaderSupported = (manifest) => manifest.loader.type === "vanilla" || !!LOADER_UIDS[manifest.loader.type];

function components(manifest, previous = []) {
  const kept = previous.filter((c) => c && c.uid !== "net.minecraft" && !ALL_LOADER_UIDS.has(c.uid));
  const list = [{ important: true, uid: "net.minecraft", version: manifest.minecraft }];
  const uid = LOADER_UIDS[manifest.loader.type];
  if (uid) list.push({ uid, version: manifest.loader.version });
  return [...list, ...kept];
}

/** A folder name for the instance that is not taken: "Aniverse", "Aniverse 2", … */
async function freeFolder(root, base) {
  const clean = base.replace(/[<>:"/\\|?*\x00-\x1f]/g, "").replace(/[. ]+$/, "") || "Aniverse";
  for (let i = 1; i < 100; i++) {
    const name = i === 1 ? clean : `${clean} ${i}`;
    if (!(await exists(path.join(root, name)))) return name;
  }
  throw new ModpackError("busy", "no free instance folder name");
}

async function install(ctx) {
  if (!loaderSupported(ctx.manifest)) throw new ModpackError("loader-unsupported", `${ctx.manifest.loader.type} on Prism`);
  const root = await instancesDir(ctx.dataDir);
  const folder = await freeFolder(root, ctx.instanceName);
  const instanceDir = path.join(root, folder);
  const gameDir = path.join(instanceDir, "minecraft");
  await fs.promises.mkdir(gameDir, { recursive: true });
  const cfg = [
    "[General]",
    "ConfigVersion=1.2",
    "InstanceType=OneSix",
    "iconKey=default",
    `name=${ctx.instanceName.replace(/[\r\n]/g, " ")}`,
    "OverrideMemory=true",
    "MinMemAlloc=512",
    `MaxMemAlloc=${ctx.memoryMB}`,
    "",
  ].join("\n");
  await fs.promises.writeFile(path.join(instanceDir, "instance.cfg"), cfg);
  await writeJsonAtomic(path.join(instanceDir, "mmc-pack.json"), { components: components(ctx.manifest), formatVersion: 1 });
  return { gameDir, ref: folder };
}

/** New Minecraft / loader version: rewrite the components, keep anything else the player added. */
async function updateLoader(record, ctx) {
  const file = path.join(path.dirname(record.gameDir), "mmc-pack.json");
  const pack = (await readJson(file)) || { formatVersion: 1, components: [] };
  pack.components = components(ctx.manifest, Array.isArray(pack.components) ? pack.components : []);
  await writeJsonAtomic(file, pack);
  return { ok: true };
}

/** Where Prism Launcher's program is, most likely first: { cmd, args, requires } for startFirst. */
function programs(sys, dataDir) {
  if (sys.platform === "win32") {
    const programFiles = sys.env.ProgramFiles || "C:\\Program Files";
    return [
      path.join(sys.localAppData, "Programs", "PrismLauncher", "prismlauncher.exe"),
      path.join(programFiles, "PrismLauncher", "prismlauncher.exe"),
      path.join(sys.home, "scoop", "apps", "prismlauncher", "current", "prismlauncher.exe"),
      path.join(dataDir, "prismlauncher.exe"), // portable: the data sits next to the program
    ].map((cmd) => ({ cmd }));
  }
  if (sys.platform === "darwin") {
    const app = "/Applications/Prism Launcher.app";
    return [{ cmd: "open", args: ["-a", app, "--args"], requires: app }];
  }
  if (dataDir.includes(path.join(".var", "app", "org.prismlauncher.PrismLauncher"))) {
    return [{ cmd: "flatpak", args: ["run", "org.prismlauncher.PrismLauncher"] }];
  }
  return [{ cmd: "prismlauncher" }];
}

/** Starts the game: Prism launches an instance by its folder name (--launch), with the player's account. */
async function launch(record, { sys, start }) {
  const instance = path.basename(path.dirname(record.gameDir));
  const candidates = programs(sys, record.dataDir).map((c) => ({ ...c, args: [...(c.args || []), "--launch", instance] }));
  if (!(await startFirst(candidates, start))) throw new ModpackError("launcher-not-found", "Prism Launcher's program was not found");
  return { opened: "game" };
}

module.exports = {
  id: ID,
  name: "Prism Launcher",
  dataDirs,
  detect,
  instancesDir,
  findInstalls,
  loaderSupported,
  install,
  updateLoader,
  programs,
  launch,
};
