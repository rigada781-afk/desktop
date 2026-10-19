// ─── Install marker ──────────────────────────────────────────────────────────
// aniverse-modpack.json at the root of every game directory we manage. It is
// how the app finds its installs again (inside any launcher) and what the
// in-game update mod reads: the installed version, where to look for a newer
// one, and the deep link that asks this app to update.
//
// {
//   "format": 1,
//   "installId": "…",                 // stable id of this install
//   "name": "Aniverse",
//   "launcher": "official" | "modrinth" | "prism",
//   "version": "2026.10.15-0015",     // manifest version installed (null until the first sync)
//   "minecraft": "1.21.1",
//   "loader": { "type": "neoforge", "version": "21.1.259" },
//   "manifestUrl": "https://raw.githubusercontent.com/<owner>/<repo>/<branch>/manifest.json",
//   "repo": { "owner": "…", "repo": "…", "branch": "…", "path": "manifest.json" } | null,
//   "updateUrl": "aniverse://minecraft/update?install=<installId>",
//   "updatedAt": "2026-10-15T10:00:00.000Z"
// }

const fs = require("fs");
const path = require("path");
const { readJson, writeJsonAtomic } = require("./sync");

const MARKER_FILE = "aniverse-modpack.json";

const markerPath = (gameDir) => path.join(gameDir, MARKER_FILE);

async function readMarker(gameDir) {
  const m = await readJson(markerPath(gameDir));
  return m && m.format === 1 && typeof m.installId === "string" && /^[A-Za-z0-9-]{1,64}$/.test(m.installId) ? m : null;
}

async function writeMarker(gameDir, marker) {
  await writeJsonAtomic(markerPath(gameDir), { format: 1, ...marker, updatedAt: new Date().toISOString() });
}

/** Subfolders of `dir` (names only); empty when it does not exist. */
async function subdirs(dir) {
  try {
    return (await fs.promises.readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch (_) {
    return [];
  }
}

module.exports = { MARKER_FILE, markerPath, readMarker, writeMarker, subdirs };
