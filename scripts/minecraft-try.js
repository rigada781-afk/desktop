// Dev tool: try the modpack sync and installs outside the app (no Electron).
//
//   node scripts/minecraft-try.js sync <manifestUrl> <gameDir>
//       Syncs the pack into gameDir, checks every file's sha1 on disk, then
//       syncs again and expects nothing to download.
//   node scripts/minecraft-try.js official <manifestUrl> <fakeAppData>
//       Installs into a stand-in official launcher under <fakeAppData>/.minecraft
//       (created with an empty launcher_profiles.json): runs the real NeoForge
//       installer with a Java 21 found on this computer.
//   node scripts/minecraft-try.js prism <manifestUrl> <fakeAppData>
//       Same with a stand-in Prism Launcher under <fakeAppData>/PrismLauncher.
//
// http manifests are only allowed on 127.0.0.1 / localhost, e.g. the pack
// tool's out/client/ served with `python -m http.server 8765 --bind 127.0.0.1`.

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { parseManifest, resolveFileUrl } = require("../minecraft/manifest");
const { createFetch, getText } = require("../minecraft/net");
const { syncPack, hashFile } = require("../minecraft/sync");
const { createModpackService } = require("../minecraft/service");
const { systemEnv, run, isGameRunning } = require("../minecraft/system");
const { ensureJava, requiredJavaMajor, MOJANG_HOSTS } = require("../minecraft/java");

const [cmd, manifestUrl, target] = process.argv.slice(2);
if (!cmd || !manifestUrl || !target) {
  console.log("usage: node scripts/minecraft-try.js sync|official|prism <manifestUrl> <dir>");
  process.exit(2);
}

const hosts = new Set([
  "raw.githubusercontent.com",
  "cdn.modrinth.com",
  "maven.neoforged.net",
  "meta.fabricmc.net",
  ...MOJANG_HOSTS,
  new URL(manifestUrl).hostname,
]);
const guardedFetch = createFetch({ hosts, allowLoopbackHttp: true });
const mb = (n) => `${(n / 1e6).toFixed(1)} MB`;

function printer() {
  let last = 0;
  return (p) => {
    if (Date.now() - last < 2000 && p.phase !== "done") return;
    last = Date.now();
    const bytes = p.bytesTotal ? ` ${mb(p.bytesDone)}/${mb(p.bytesTotal)}` : "";
    console.log(`  ${p.phase} ${p.done}/${p.total}${bytes}`);
  };
}

async function verifyAll(manifest, gameDir) {
  let bad = 0;
  for (const f of manifest.files) {
    const file = path.join(gameDir, ...f.path.split("/"));
    const st = fs.statSync(file, { throwIfNoEntry: false });
    if (!st) {
      console.log(`  MISSING ${f.path}`);
      bad++;
    } else if (f.mode !== "once" && (st.size !== f.size || (await hashFile(file)) !== f.sha1)) {
      console.log(`  WRONG ${f.path}`);
      bad++;
    }
  }
  return bad;
}

async function trySync() {
  const manifest = parseManifest(await getText(guardedFetch, manifestUrl));
  console.log(`manifest ${manifest.version}: ${manifest.files.length} files, ${mb(manifest.files.reduce((n, f) => n + f.size, 0))}`);
  const opts = { gameDir: target, manifest, resolveUrl: (u) => resolveFileUrl(manifestUrl, u), fetch: guardedFetch, onProgress: printer() };
  let t = Date.now();
  const first = await syncPack(opts);
  console.log(`run 1: ${first.downloaded.length} downloaded (${mb(first.bytesDownloaded)}), ${first.removed.length} removed, ${((Date.now() - t) / 1000).toFixed(1)} s`);
  const bad = await verifyAll(manifest, target);
  console.log(`sha1 check of all ${manifest.files.length} files: ${bad === 0 ? "OK" : `${bad} BAD`}`);
  t = Date.now();
  const second = await syncPack({ ...opts, onProgress: undefined });
  console.log(`run 2: ${second.downloaded.length} downloaded, ${second.removed.length} removed, ${((Date.now() - t) / 1000).toFixed(1)} s`);
  if (bad || second.downloaded.length || second.removed.length) process.exitCode = 1;
}

async function tryLauncher(id) {
  const appData = path.resolve(target);
  const sys = systemEnv({ platform: process.platform, home: os.homedir(), env: { ...process.env, APPDATA: appData } });
  if (id === "official") {
    const profiles = path.join(appData, ".minecraft", "launcher_profiles.json");
    if (!fs.existsSync(profiles)) {
      fs.mkdirSync(path.dirname(profiles), { recursive: true });
      fs.writeFileSync(profiles, JSON.stringify({ profiles: {}, settings: {}, version: 3 }, null, 2));
    }
  } else {
    fs.mkdirSync(path.join(appData, "PrismLauncher"), { recursive: true });
    fs.writeFileSync(path.join(appData, "PrismLauncher", "prismlauncher.cfg"), "InstanceDir=instances\n");
  }
  const launchers = { [id]: require(`../minecraft/launchers/${id}`) };
  let records = [];
  const realSys = systemEnv(); // Java is looked up in the real launcher folders
  const service = createModpackService({
    source: { manifestUrl },
    sys,
    launchers,
    guardedFetch,
    store: { get: () => records, set: (v) => (records = v) },
    openFile: async () => "not available here",
    runImpl: (c, a, o) => run(c, a, { ...o, onLine: (l) => /error|exception/i.test(l) && console.log(`  [installer] ${l}`) }),
    isGameRunning,
    ensureJava: (mc, o) =>
      ensureJava(realSys, { major: requiredJavaMajor(mc), ownRuntimeDir: path.join(appData, "runtime"), guardedFetch, ...o }),
    tmpDir: path.join(appData, "tmp"),
    newId: () => crypto.randomUUID(),
    onProgress: printer(),
  });
  console.log("detected:", (await service.detect()).map((d) => `${d.launcher} ${d.dataDir}`));
  let t = Date.now();
  const r = await service.install({ launcher: id });
  console.log(`install: ${r.downloaded} files (${mb(r.bytes)}) in ${((Date.now() - t) / 1000).toFixed(1)} s →`, r.install.gameDir);
  const manifest = parseManifest(await getText(guardedFetch, manifestUrl));
  const bad = await verifyAll(manifest, r.install.gameDir);
  console.log(`sha1 check: ${bad === 0 ? "OK" : `${bad} BAD`}`);
  t = Date.now();
  const u = await service.update(undefined, { verify: true });
  console.log(`update (full verify): ${JSON.stringify(u.results)} in ${((Date.now() - t) / 1000).toFixed(1)} s`);
  if (bad) process.exitCode = 1;
}

(cmd === "sync" ? trySync() : tryLauncher(cmd)).catch((err) => {
  console.error(`FAILED (${err.code || err.name}): ${err.message}`);
  process.exitCode = 1;
});
