// ─── Output file names ───────────────────────────────────────────────────────
// Windows-safe names built from the page's titles, never a path from the
// page, de-duplicated inside the chosen folder (" (2)", " (3)" …). Episodes go
// in <download folder>/anime/ as "chainsaw-man-ep-1.mp4" (owner, 2026-10-19),
// manga chapters in manga/ (chapters.js).

const path = require("path");
const { DownloadError } = require("./errors");

const MAX_NAME_LENGTH = 150;
const EXTENSION = ".mp4";
const MAX_SLUG_LENGTH = 100;
/** The download folder's subfolders, one per kind. */
const ANIME_FOLDER = "anime";
const MANGA_FOLDER = "manga";
const RESERVED_NAMES = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i;

// Truncates to `max` UTF-16 units without splitting a surrogate pair.
function truncate(text, max) {
  if (text.length <= max) return text;
  let out = "";
  for (const char of text) {
    if (out.length + char.length > max) break;
    out += char;
  }
  return out;
}

function trimEdges(text) {
  return text.replace(/^[\s.]+/, "").replace(/[\s.]+$/, "");
}

// Removes what Windows (and the shells) cannot take in a file name.
function cleanTitle(text) {
  return trimEdges(
    String(text ?? "")
      .normalize("NFC")
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
      // bidi overrides / zero-width characters could hide the extension
      .replace(/[​-‏‪-‮⁦-⁩﻿]/g, "")
      .replace(/:\s/g, " - ") // "Kaguya-sama: Love Is War" → "Kaguya-sama - Love Is War"
      .replace(/[:/\\|]/g, "-") // "Re:Zero", "Fate/Zero"
      .replace(/"/g, "'")
      .replace(/[<>?*]/g, "")
      .replace(/\s+/g, " "),
  );
}

/** "<stem>.mp4", Windows-safe, at most 150 characters. */
function sanitizeFileName(stem) {
  let base = cleanTitle(stem);
  if (!base) base = "Aniverse";
  base = trimEdges(truncate(base, MAX_NAME_LENGTH - EXTENSION.length));
  if (RESERVED_NAMES.test(base.split(".")[0].trim())) base = `_${base}`;
  return `${base}${EXTENSION}`;
}

/** "Chainsaw Man: Part 2 !" → "chainsaw-man-part-2": ASCII, lowercase, dashes. */
function slugifyName(text) {
  return String(text ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/, "");
}

/** A number in a name: 12 → "12", 12.5 → "12-5". */
function numberSlug(value) {
  return String(value).replace(/[^0-9]+/g, "-").replace(/^-+|-+$/g, "") || "0";
}

/** The site's permalink when it has one, else the title, as a slug. */
function titleSlug(item) {
  return slugifyName(item.slug) || slugifyName(item.title) || "aniverse";
}

/**
 * "chainsaw-man-ep-1.mp4"; VF: "chainsaw-man-ep-1-vf.mp4" (both languages
 * can sit side by side); a movie: "your-name.mp4", "your-name-vf.mp4".
 */
function buildFileName({ anime, episode, language }) {
  const dub = language === "dub" ? "-vf" : "";
  const slug = titleSlug(anime);
  return sanitizeFileName(anime.isMovie ? `${slug}${dub}` : `${slug}-ep-${numberSlug(episode.number)}${dub}`);
}

/** "<dir>/<stem>.part.mp4": where ffmpeg writes before the final rename. */
function partPathFor(outputPath) {
  return `${outputPath.replace(/\.mp4$/i, "")}.part${EXTENSION}`;
}

/** Comparison key: Windows and macOS file systems ignore case. */
function pathKey(filePath) {
  return path.resolve(filePath).toLowerCase();
}

function assertInside(folder, filePath) {
  const root = path.resolve(folder);
  const prefix = root.endsWith(path.sep) ? root : root + path.sep; // "D:\" stays "D:\"
  const resolved = path.resolve(filePath);
  if (path.dirname(resolved) !== root || !resolved.startsWith(prefix)) {
    throw new DownloadError("disk", "output path outside the download folder");
  }
  return resolved;
}

/**
 * First free "<name>", "<name> (2)", … in `folder`. `isTaken(fullPath)`
 * covers existing files, their .part file and other running jobs.
 */
function uniqueOutputPath(folder, fileName, isTaken) {
  const ext = path.extname(fileName);
  const stem = fileName.slice(0, fileName.length - ext.length);
  for (let n = 1; n < 10_000; n++) {
    const name = n === 1 ? fileName : `${stem} (${n})${ext}`;
    const full = assertInside(folder, path.join(folder, name));
    if (!isTaken(full)) return { fileName: name, outputPath: full };
  }
  throw new DownloadError("disk", "no free file name");
}

module.exports = {
  MAX_NAME_LENGTH,
  ANIME_FOLDER,
  MANGA_FOLDER,
  cleanTitle,
  slugifyName,
  numberSlug,
  titleSlug,
  sanitizeFileName,
  buildFileName,
  partPathFor,
  pathKey,
  assertInside,
  uniqueOutputPath,
};
