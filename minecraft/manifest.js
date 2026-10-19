// ─── Modpack manifest ────────────────────────────────────────────────────────
// The pack tool's out/client/manifest.json (pack-tool/README.md "Manifest
// format (for the launcher)"), published on a branch of a GitHub repo next to
// its objects/ folder. Files hosted there are named by their sha1 and never
// change; Modrinth files keep their absolute cdn.modrinth.com urls.
//
// The branch head is resolved to a commit first (GitHub API), so a fresh
// update is seen at once instead of after raw.githubusercontent.com's ~5 min
// cache; relative urls then resolve against that same commit.

const { ModpackError } = require("./errors");
const { getText, USER_AGENT } = require("./net");
const { validateFilePath, validateManagedDir } = require("./paths");

const MANIFEST_FORMAT = 1;
const LOADERS = new Set(["vanilla", "fabric", "quilt", "forge", "neoforge"]);
const SHA1 = /^[a-f0-9]{40}$/i;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/;
const MC_VERSION = /^[0-9A-Za-z.\-_ ]{1,32}$/;
const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024;

function bad(message) {
  return new ModpackError("invalid-manifest", message);
}

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** Validates manifest JSON text. Paths are normalized; one bad entry rejects the whole manifest. */
function parseManifest(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (_) {
    throw bad("manifest is not json");
  }
  if (!isObject(raw)) throw bad("manifest is not an object");
  if (typeof raw.format === "number" && raw.format > MANIFEST_FORMAT) {
    throw new ModpackError("update-required", `manifest format ${raw.format} needs a newer app`);
  }
  if (raw.format !== MANIFEST_FORMAT) throw bad("unknown manifest format");
  if (typeof raw.version !== "string" || !VERSION.test(raw.version)) throw bad("bad version");
  if (typeof raw.minecraft !== "string" || !MC_VERSION.test(raw.minecraft)) throw bad("bad minecraft version");
  const loader = raw.loader;
  if (!isObject(loader) || !LOADERS.has(loader.type)) throw bad("bad loader");
  const loaderVersion = loader.version === undefined ? "" : loader.version;
  if (typeof loaderVersion !== "string" || !/^[0-9A-Za-z.+_-]{0,64}$/.test(loaderVersion)) throw bad("bad loader version");
  if (loader.type !== "vanilla" && !loaderVersion) throw bad("missing loader version");
  if (loader.installer_sha1 !== undefined && !(typeof loader.installer_sha1 === "string" && SHA1.test(loader.installer_sha1))) {
    throw bad("bad installer_sha1");
  }
  const managed = raw.managed_dirs === undefined ? [] : raw.managed_dirs;
  if (!Array.isArray(managed) || managed.length > 16) throw bad("bad managed_dirs");
  if (!Array.isArray(raw.files) || raw.files.length > 20_000) throw bad("bad files");

  const seen = new Set();
  const files = raw.files.map((f, i) => {
    if (!isObject(f)) throw bad(`files[${i}] is not an object`);
    const filePath = validateFilePath(f.path);
    const key = filePath.toLowerCase();
    if (seen.has(key)) throw bad(`duplicate path: ${filePath}`);
    seen.add(key);
    if (typeof f.sha1 !== "string" || !SHA1.test(f.sha1)) throw bad(`files[${i}].sha1`);
    if (!Number.isInteger(f.size) || f.size < 0 || f.size > MAX_FILE_SIZE) throw bad(`files[${i}].size`);
    const mode = f.mode === undefined ? "sync" : f.mode;
    if (mode !== "sync" && mode !== "once") throw bad(`files[${i}].mode`);
    if (typeof f.url !== "string" || f.url.length === 0 || f.url.length > 2048) throw bad(`files[${i}].url`);
    return { path: filePath, sha1: f.sha1.toLowerCase(), size: f.size, mode, url: f.url };
  });

  return {
    format: MANIFEST_FORMAT,
    name: typeof raw.name === "string" ? raw.name.slice(0, 128) : "",
    version: raw.version,
    generated: typeof raw.generated === "string" ? raw.generated.slice(0, 64) : null,
    minecraft: raw.minecraft,
    loader: {
      type: loader.type,
      version: loaderVersion,
      ...(loader.installer_sha1 ? { installer_sha1: loader.installer_sha1.toLowerCase() } : {}),
    },
    managed_dirs: managed.map(validateManagedDir),
    files,
  };
}

/** A file url resolved against the manifest's url ("objects/ab/ab12…" → next to manifest.json). */
function resolveFileUrl(manifestUrl, url) {
  return new URL(url, manifestUrl).toString();
}

/** source: { manifestUrl } or { repo: { owner, repo, branch, path } } */
function branchManifestUrl(source) {
  if (source.manifestUrl) return source.manifestUrl;
  const { owner, repo, branch, path: file = "manifest.json" } = source.repo;
  return `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(branch)}/${file}`;
}

/** The manifest url pinned to the branch's current commit (falls back to the branch url). */
async function resolveManifestUrl(source, { fetchImpl = (u, init) => fetch(u, init), signal } = {}) {
  if (source.manifestUrl) return source.manifestUrl;
  const { owner, repo, branch, path: file = "manifest.json" } = source.repo;
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(branch)}`, {
      headers: { accept: "application/vnd.github.sha", "user-agent": USER_AGENT },
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)].filter(Boolean)),
    });
    const sha = (await res.text()).trim();
    if (res.ok && SHA1.test(sha)) return `https://raw.githubusercontent.com/${owner}/${repo}/${sha}/${file}`;
  } catch (err) {
    if (signal?.aborted) throw err;
    // rate-limited (60 requests / hour / IP) or offline: the branch url below
  }
  return branchManifestUrl(source);
}

/** → { manifest, url } where url is what relative file urls resolve against. */
async function fetchManifest(source, { guardedFetch, fetchImpl, signal } = {}) {
  const url = await resolveManifestUrl(source, { fetchImpl, signal });
  const text = await getText(guardedFetch, url, { signal });
  return { manifest: parseManifest(text), url };
}

module.exports = {
  MANIFEST_FORMAT,
  parseManifest,
  resolveFileUrl,
  branchManifestUrl,
  resolveManifestUrl,
  fetchManifest,
};
