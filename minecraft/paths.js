// ─── Safe paths for manifest data ────────────────────────────────────────────
// Every path that comes from the manifest goes through here before it touches
// the disk: no absolute paths, drive letters, UNC, "..", reserved names, and
// only the folders a modpack may write to inside a game directory.

const fs = require("fs");
const path = require("path");
const { ModpackError } = require("./errors");

const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

// Top-level entries a manifest may write to. Saves, screenshots, logs and the
// launcher's own files are never reachable.
const ALLOWED_TOP = new Set([
  "mods",
  "config",
  "defaultconfigs",
  "kubejs",
  "resourcepacks",
  "shaderpacks",
  "datapacks",
  "options.txt",
  "servers.dat",
]);
const TOP_FILES = new Set(["options.txt", "servers.dat"]);

function unsafe(rel, why) {
  return new ModpackError("invalid-manifest", `unsafe path (${why}): ${JSON.stringify(String(rel)).slice(0, 120)}`);
}

/** A relative path in "a/b/c" form, or throws. */
function normalizeRelPath(rel) {
  if (typeof rel !== "string" || rel.length === 0 || rel.length > 512) throw unsafe(rel, "length");
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(rel)) throw unsafe(rel, "control char");
  if (rel.includes(":")) throw unsafe(rel, "colon"); // drive letters, alternate data streams
  const p = rel.replace(/\\/g, "/");
  if (p.startsWith("/")) throw unsafe(rel, "absolute");
  if (/[<>"|?*]/.test(p)) throw unsafe(rel, "reserved char");
  const segs = p.split("/");
  for (const s of segs) {
    if (s === "" || s === "." || s === "..") throw unsafe(rel, "segment");
    if (s.endsWith(".") || s.endsWith(" ")) throw unsafe(rel, "trailing dot or space");
    if (RESERVED.test(s)) throw unsafe(rel, "reserved name");
  }
  return segs.join("/");
}

/** A manifest file path: safe and under an allowed top-level folder. */
function validateFilePath(rel) {
  const norm = normalizeRelPath(rel);
  const top = norm.split("/")[0].toLowerCase();
  if (!ALLOWED_TOP.has(top)) throw unsafe(rel, "outside the allowed folders");
  if (!norm.includes("/") && !TOP_FILES.has(top)) throw unsafe(rel, "not a file path");
  return norm;
}

/** A managed dir ("mods", "kubejs/scripts"): never saves/, the game root or a single file. */
function validateManagedDir(dir) {
  const norm = normalizeRelPath(typeof dir === "string" ? dir.replace(/[\\/]+$/, "") : dir);
  const top = norm.split("/")[0].toLowerCase();
  if (!ALLOWED_TOP.has(top) || TOP_FILES.has(top)) throw unsafe(dir, "managed dir not allowed");
  return norm;
}

/** root + rel, proven to stay inside root. */
function safeJoin(root, rel) {
  const norm = normalizeRelPath(rel);
  const base = path.resolve(root);
  const full = path.resolve(base, ...norm.split("/"));
  const back = path.relative(base, full);
  if (!back || back.startsWith("..") || path.isAbsolute(back)) throw unsafe(rel, "escapes the game directory");
  return full;
}

/** Refuses to write through a symlink / junction between root and rel (parents only by default). */
async function assertNoSymlinks(root, rel, { includeLeaf = false } = {}) {
  const segs = normalizeRelPath(rel).split("/");
  if (!includeLeaf) segs.pop();
  let cur = path.resolve(root);
  for (const seg of segs) {
    cur = path.join(cur, seg);
    let st;
    try {
      st = await fs.promises.lstat(cur);
    } catch (_) {
      return;
    }
    if (st.isSymbolicLink()) throw unsafe(rel, "symlink in the way");
  }
}

/** Comparison key: Windows and default macOS volumes ignore case, Linux does not. */
function pathKey(rel, platform = process.platform) {
  return platform === "linux" ? rel : rel.toLowerCase();
}

module.exports = {
  ALLOWED_TOP,
  normalizeRelPath,
  validateFilePath,
  validateManagedDir,
  safeJoin,
  assertNoSymlinks,
  pathKey,
};
