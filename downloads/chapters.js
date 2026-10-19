// ─── Manga chapters (.avm files) ─────────────────────────────────────────────
// The site builds a chapter's .avm file (its pages, encrypted; the format is
// the site's lib/downloads/avm.ts) and hands it over: it is checked, written
// in <download folder>/manga/ as "chainsaw-man-chapter-1.avm" (owner,
// 2026-10-19) and recorded as a completed download
// (mediaType "manga"), which the site reads on /downloads/read through the
// aniverse-media: scheme (media.js). Downloading the same chapter again
// replaces its file and record. No Electron here.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { MANGA_FOLDER, numberSlug, pathKey, titleSlug, uniqueOutputPath } = require("./files");

const MAGIC = Buffer.from("AVM1", "latin1");
const MAX_BYTES = 1024 * 1024 * 1024;
const MAX_TITLE = 300;
const MAX_PAGES = 5000;
const EXTENSION = ".avm";

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function text(value, max, { required = false } = {}) {
  if (value === undefined || value === null || value === "") return required ? undefined : null;
  if (typeof value !== "string" || value.length > max) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return required ? undefined : null;
  return trimmed;
}

function httpUrlOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 8192) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

function toBuffer(bytes) {
  if (Buffer.isBuffer(bytes)) return bytes;
  if (bytes instanceof Uint8Array) return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes instanceof ArrayBuffer) return Buffer.from(bytes);
  return null;
}

/**
 * The page's request, checked and copied (never a path or a folder from it).
 * @returns {{ ok: true, request: object } | { ok: false }}
 */
function validateChapterRequest(raw) {
  if (!isPlainObject(raw) || !isPlainObject(raw.manga) || !isPlainObject(raw.chapter)) return { ok: false };
  const manga = {
    id: text(raw.manga.id, 200, { required: true }),
    title: text(raw.manga.title, MAX_TITLE, { required: true }),
    slug: text(raw.manga.slug, MAX_TITLE),
    image: httpUrlOrNull(raw.manga.image),
  };
  const chapter = {
    id: text(raw.chapter.id, 200, { required: true }),
    number: text(raw.chapter.number, 20, { required: true }),
    title: text(raw.chapter.title, MAX_TITLE),
    kind: raw.chapter.kind === "tome" ? "tome" : raw.chapter.kind === "chapter" ? "chapter" : undefined,
  };
  if (Object.values(manga).includes(undefined) || Object.values(chapter).includes(undefined)) return { ok: false };
  if (!/^\d{1,6}(?:\.\d{1,3})?$/.test(chapter.number)) return { ok: false };
  if (manga.slug !== null && /[\\/\s]/.test(manga.slug)) return { ok: false };
  const pageCount = raw.pageCount;
  if (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > MAX_PAGES) return { ok: false };
  const bytes = toBuffer(raw.bytes);
  if (!bytes || bytes.length <= MAGIC.length + 5 || bytes.length > MAX_BYTES) return { ok: false };
  if (!bytes.subarray(0, MAGIC.length).equals(MAGIC)) return { ok: false };
  return { ok: true, request: { manga, chapter, pageCount, bytes } };
}

/** "chainsaw-man-chapter-12.avm", "one-piece-tome-3.avm", "x-chapter-12-5.avm". */
function chapterFileName({ manga, chapter }) {
  return `${titleSlug(manga)}-${chapter.kind === "tome" ? "tome" : "chapter"}-${numberSlug(chapter.number)}${EXTENSION}`;
}

/**
 * @param {object} options
 * @param {ReturnType<import("./manager").createDownloadManager>} options.manager
 * @param {() => string} options.getFolder  the download folder
 */
function createChapterSaver({ manager, getFolder, now = Date.now, idFactory = () => crypto.randomUUID() }) {
  /**
   * @returns {Promise<{ ok: true, id: string } | { ok: false, error: "invalid-request" | "disk" }>}
   */
  async function save(raw) {
    const parsed = validateChapterRequest(raw);
    if (!parsed.ok) return { ok: false, error: "invalid-request" };
    const { manga, chapter, pageCount, bytes } = parsed.request;

    const previous = manager
      .list()
      .filter((record) => record.mediaType === "manga" && record.chapter?.id === chapter.id);
    let folder;
    let output;
    try {
      folder = path.join(path.resolve(getFolder()), MANGA_FOLDER);
      fs.mkdirSync(folder, { recursive: true });
      // The same chapter again: its file is replaced where it is
      const reuse = previous.find(
        (record) =>
          typeof record.outputPath === "string" &&
          path.dirname(path.resolve(record.outputPath)) === folder &&
          fs.existsSync(record.outputPath),
      );
      output = reuse
        ? { fileName: path.basename(reuse.outputPath), outputPath: path.resolve(reuse.outputPath) }
        : uniqueOutputPath(folder, chapterFileName({ manga, chapter }), (p) => fs.existsSync(p) || fs.existsSync(`${p}.part`));
      const part = `${output.outputPath}.part`;
      await fs.promises.writeFile(part, bytes);
      await fs.promises.rename(part, output.outputPath);
    } catch (err) {
      console.error("[download] could not save the chapter:", err.message);
      return { ok: false, error: "disk" };
    }

    // Older copies of this chapter elsewhere: their files go with their records
    for (const record of previous) {
      if (typeof record.outputPath !== "string" || pathKey(record.outputPath) === pathKey(output.outputPath)) continue;
      try {
        if (record.status === "completed" && fs.statSync(record.outputPath).isFile()) fs.unlinkSync(record.outputPath);
      } catch (_) {}
    }

    const time = now();
    const record = {
      id: idFactory(),
      status: "completed",
      phase: null,
      progress: 100,
      mediaType: "manga",
      manga,
      chapter,
      pageCount,
      watchPath: `/read/${encodeURIComponent(manga.slug ?? manga.id)}/${encodeURIComponent(chapter.id)}`,
      quality: null,
      subtitles: [],
      fileName: output.fileName,
      outputPath: output.outputPath,
      sizeBytes: bytes.length,
      createdAt: time,
      startedAt: time,
      finishedAt: time,
    };
    manager.addCompleted(record, { replaces: previous.map((item) => item.id) });
    return { ok: true, id: record.id };
  }

  return { save };
}

module.exports = { createChapterSaver, validateChapterRequest, chapterFileName, MANGA_FOLDER };
