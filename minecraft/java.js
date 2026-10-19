// ─── Java for the NeoForge installer ──────────────────────────────────────────
// Only the official launcher needs it: its NeoForge version is made by running
// NeoForge's installer, which is a Java program. Looks for a Java that is new
// enough among the runtimes the launchers already downloaded (official
// launcher, Microsoft Store launcher, Modrinth App, Prism), JAVA_HOME and the
// PATH; otherwise downloads Mojang's own runtime (the one the official
// launcher uses), file by file with its sha1.

const fs = require("fs");
const path = require("path");
const { ModpackError } = require("./errors");
const { downloadFile, runPool } = require("./download");
const { getText } = require("./net");
const { exists, run } = require("./system");

const MOJANG_RUNTIMES =
  "https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json";
const MOJANG_HOSTS = ["launchermeta.mojang.com", "piston-meta.mojang.com", "piston-data.mojang.com"];
const COMPONENTS = { 8: "jre-legacy", 17: "java-runtime-gamma", 21: "java-runtime-delta", 25: "java-runtime-epsilon" };

/** Java major version a Minecraft version needs. */
function requiredJavaMajor(mcVersion) {
  const [, minor = 0, patch = 0] = String(mcVersion).split(".").map((n) => parseInt(n, 10) || 0);
  const major = parseInt(String(mcVersion).split(".")[0], 10) || 1;
  if (major > 1) return major >= 26 ? 25 : 21; // year-based versions (26.x)
  if (minor > 20 || (minor === 20 && patch >= 5)) return 21;
  if (minor >= 18) return 17;
  return 8;
}

function mojangPlatform(platform = process.platform, arch = process.arch) {
  if (platform === "win32") return { x64: "windows-x64", ia32: "windows-x86", arm64: "windows-arm64" }[arch] || null;
  if (platform === "darwin") return arch === "arm64" ? "mac-os-arm64" : "mac-os";
  if (platform === "linux") return { x64: "linux", ia32: "linux-i386" }[arch] || null;
  return null;
}

/** "openjdk version \"21.0.8\" …" / "java version \"1.8.0_51\"" → 21 / 8 */
function parseJavaMajor(text) {
  const m = /version "(\d+)(?:\.(\d+))?/.exec(text || "");
  if (!m) return null;
  const first = parseInt(m[1], 10);
  return first === 1 ? parseInt(m[2] || "0", 10) : first;
}

/** Folders where launchers keep the Java runtimes they downloaded. */
function runtimeRoots(sys, { ownRuntimeDir } = {}) {
  const roots = [];
  if (ownRuntimeDir) roots.push(ownRuntimeDir);
  if (sys.platform === "win32") {
    roots.push(
      path.join(sys.appData, ".minecraft", "runtime"),
      path.join(sys.localAppData, "Packages", "Microsoft.4297127D64EC6_8wekyb3d8bbwe", "LocalCache", "Local", "runtime"),
      path.join(sys.appData, "ModrinthApp", "meta", "java_versions"),
      path.join(sys.appData, "com.modrinth.theseus", "meta", "java_versions"),
      path.join(sys.appData, "PrismLauncher", "java"),
    );
  } else if (sys.platform === "darwin") {
    roots.push(
      path.join(sys.macSupport, "minecraft", "runtime"),
      path.join(sys.macSupport, "ModrinthApp", "meta", "java_versions"),
      path.join(sys.macSupport, "PrismLauncher", "java"),
    );
  } else {
    roots.push(
      path.join(sys.home, ".minecraft", "runtime"),
      path.join(sys.xdgData, "ModrinthApp", "meta", "java_versions"),
      path.join(sys.xdgData, "PrismLauncher", "java"),
    );
  }
  if (sys.env.JAVA_HOME) roots.push(sys.env.JAVA_HOME);
  return roots;
}

/** bin/java(.exe) files under root, at most `depth` folders deep. */
async function findBinaries(root, exe, depth = 6, out = []) {
  if (depth < 0 || out.length > 50) return out;
  let entries;
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true });
  } catch (_) {
    return out;
  }
  for (const d of entries) {
    if (d.isDirectory()) {
      if (d.name === "bin" && (await exists(path.join(root, d.name, exe)))) out.push(path.join(root, d.name, exe));
      else if (d.name !== "lib" && d.name !== "legal" && d.name !== "conf") await findBinaries(path.join(root, d.name), exe, depth - 1, out);
    }
  }
  return out;
}

async function probe(javaPath, runImpl) {
  try {
    const r = await runImpl(javaPath, ["-version"], { timeoutMs: 20_000 });
    return r.code === 0 ? parseJavaMajor(`${r.stderr}\n${r.stdout}`) : null;
  } catch (_) {
    return null;
  }
}

/** → { path, major } for the first Java ≥ minMajor, or null. */
async function findJava(sys, { minMajor, ownRuntimeDir, runImpl = run } = {}) {
  const exe = sys.platform === "win32" ? "java.exe" : "java";
  const seen = new Set();
  for (const root of runtimeRoots(sys, { ownRuntimeDir })) {
    for (const bin of await findBinaries(root, exe)) {
      if (seen.has(bin)) continue;
      seen.add(bin);
      const major = await probe(bin, runImpl);
      if (major !== null && major >= minMajor) return { path: bin, major };
    }
  }
  const major = await probe(exe, runImpl); // PATH
  if (major !== null && major >= minMajor) return { path: exe, major };
  return null;
}

/**
 * Downloads Mojang's runtime for `major` into ownRuntimeDir/<component>/ and returns its java path.
 * guardedFetch must allow the Mojang hosts (MOJANG_HOSTS).
 */
async function downloadJava(sys, { major, ownRuntimeDir, guardedFetch, signal, onProgress, arch = process.arch }) {
  const component = COMPONENTS[major];
  const key = mojangPlatform(sys.platform, arch);
  if (!component || !key) throw new ModpackError("java-not-found", `no Java ${major} download for ${sys.platform}-${arch}`);
  const all = JSON.parse(await getText(guardedFetch, MOJANG_RUNTIMES, { signal }));
  const entry = all?.[key]?.[component]?.[0];
  if (!entry?.manifest?.url) throw new ModpackError("java-not-found", `Mojang has no ${component} for ${key}`);
  const manifest = JSON.parse(await getText(guardedFetch, entry.manifest.url, { signal }));
  const dir = path.join(ownRuntimeDir, component);
  const marker = path.join(dir, ".installed");
  const exe = sys.platform === "win32" ? "bin/java.exe" : sys.platform === "darwin" ? "jre.bundle/Contents/Home/bin/java" : "bin/java";
  if ((await fs.promises.readFile(marker, "utf8").catch(() => "")) === entry.manifest.sha1) return path.join(dir, ...exe.split("/"));

  const files = [];
  const links = [];
  for (const [rel, f] of Object.entries(manifest.files || {})) {
    const target = path.resolve(dir, ...rel.split("/"));
    if (path.relative(dir, target).startsWith("..")) throw new ModpackError("java-not-found", "bad runtime path");
    if (f.type === "directory") await fs.promises.mkdir(target, { recursive: true });
    else if (f.type === "file" && f.downloads?.raw) files.push({ rel, target, raw: f.downloads.raw, executable: !!f.executable });
    else if (f.type === "link" && typeof f.target === "string") links.push({ target, link: f.target });
  }
  const bytesTotal = files.reduce((n, f) => n + f.raw.size, 0);
  let bytesDone = 0;
  let done = 0;
  await runPool(
    files,
    8,
    async (f, poolSignal) => {
      const st = await fs.promises.stat(f.target).catch(() => null);
      if (!st || st.size !== f.raw.size) {
        await downloadFile(
          { id: f.rel, url: f.raw.url, dest: f.target, part: `${f.target}.part`, size: f.raw.size, sha1: f.raw.sha1 },
          { fetch: guardedFetch, signal: poolSignal, onBytes: (d) => (bytesDone += d) },
        );
      } else {
        bytesDone += f.raw.size;
      }
      if (f.executable && sys.platform !== "win32") await fs.promises.chmod(f.target, 0o755);
      done++;
      onProgress?.({ phase: "java", done, total: files.length, bytesDone, bytesTotal });
    },
    signal,
  );
  if (sys.platform !== "win32") {
    for (const l of links) {
      const resolved = path.resolve(path.dirname(l.target), l.link);
      if (path.relative(dir, resolved).startsWith("..")) continue; // never point outside the runtime
      await fs.promises.rm(l.target, { force: true });
      await fs.promises.symlink(l.link, l.target).catch(() => {});
    }
  }
  await fs.promises.writeFile(marker, entry.manifest.sha1);
  return path.join(dir, ...exe.split("/"));
}

/** A Java ≥ major: an installed one, else Mojang's (downloaded once into ownRuntimeDir). */
async function ensureJava(sys, opts) {
  const found = await findJava(sys, { minMajor: opts.major, ownRuntimeDir: opts.ownRuntimeDir, runImpl: opts.runImpl });
  if (found) return found.path;
  const javaPath = await downloadJava(sys, opts);
  if ((await probe(javaPath, opts.runImpl || run)) === null) throw new ModpackError("java-not-found", "downloaded Java does not run");
  return javaPath;
}

module.exports = {
  MOJANG_HOSTS,
  requiredJavaMajor,
  mojangPlatform,
  parseJavaMajor,
  runtimeRoots,
  findJava,
  downloadJava,
  ensureJava,
};
