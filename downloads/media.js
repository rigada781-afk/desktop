// ─── Local playback (the site's /downloads/watch) ────────────────────────────
// Serves completed downloads to the app's own pages through the
// aniverse-media: scheme, looked up by record id (never a path from the page):
//
//   aniverse-media://video/<id>                    the .mp4, with byte ranges (seeking)
//   aniverse-media://subtitle/<id>/<index>         one subtitle track, as text
//   aniverse-media://image/<id>/<anime|episode>    the poster, kept on the disk
//   aniverse-media://chapter/<id>                  a manga chapter's .avm file
//                                                  (chapters.js), which the page decrypts
//   aniverse-media://opened/<token>                an .avm file opened from the system's
//                                                  file explorer (openFile: by token, never a path)
//
// Subtitles: the original text, kept next to the record when the download
// finished (sidecar); downloads from before that get it extracted from the
// mp4's mov_text track by ffmpeg (WebVTT), kept too. Posters: fetched once
// (online), then served from the disk, so the downloads show offline.
// Everything lives in userData/downloads-media/<id>, removed with the record.
// No Electron here: index.js registers the scheme and injects fetch / paths.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Readable } = require("stream");
const { spawn: defaultSpawn } = require("child_process");

const SCHEME = "aniverse-media";
const IMAGE_KINDS = new Set(["anime", "episode"]);
const SUBTITLE_TYPES = { vtt: "text/vtt", srt: "text/srt", ass: "text/ass" };
const IMAGE_TYPES = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/gif": "gif",
};
const EXTENSION_TYPES = Object.fromEntries(
  Object.entries(IMAGE_TYPES).map(([type, ext]) => [ext, type]),
);
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_AVM_BYTES = 1024 * 1024 * 1024;
const MAX_SUBTITLE_BYTES = 10 * 1024 * 1024;
const EXTRACT_TIMEOUT_MS = 60_000;
const IMAGE_TIMEOUT_MS = 15_000;
// Record ids are the manager's UUIDs: nothing else reaches the disk.
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function videoUrl(id) {
  return `${SCHEME}://video/${id}`;
}

function subtitleUrl(id, index) {
  return `${SCHEME}://subtitle/${id}/${index}`;
}

function imageUrl(id, kind) {
  return `${SCHEME}://image/${id}/${kind}`;
}

function chapterUrl(id) {
  return `${SCHEME}://chapter/${id}`;
}

/**
 * "bytes=0-", "bytes=100-199", "bytes=-500" against a file of `size` bytes.
 * @returns {{ start: number, end: number } | null | "unsatisfiable"}
 *   null: no (usable) range, the whole file
 */
function parseRange(header, size) {
  if (typeof header !== "string") return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === "" && match[2] === "")) return null;
  let start;
  let end;
  if (match[1] === "") {
    // The last N bytes
    const suffix = Number(match[2]);
    if (suffix === 0) return "unsatisfiable";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null;
  if (start >= size || end < start) return "unsatisfiable";
  return { start, end };
}

/** aniverse-media://<kind>/<id>/<rest> → its parts, or null. */
function parseMediaUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== `${SCHEME}:`) return null;
  const kind = url.hostname.toLowerCase();
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const [id, extra] = parts;
  if (!ID.test(id ?? "") || parts.length > 2) return null;
  if ((kind === "video" || kind === "chapter" || kind === "opened") && parts.length === 1) return { kind, id };
  if (kind === "subtitle" && /^\d{1,2}$/.test(extra ?? "")) return { kind, id, index: Number(extra) };
  if (kind === "image" && IMAGE_KINDS.has(extra)) return { kind, id, image: extra };
  return null;
}

function fileStream(file, options) {
  return Readable.toWeb(fs.createReadStream(file, options));
}

/**
 * @param {object} options
 * @param {(id: string) => object | null} options.getRecord  the manager's record
 * @param {string} options.root  userData/downloads-media
 * @param {() => string | null} [options.ffmpegPath]
 * @param {typeof fetch} [options.fetchImpl]  Electron's net.fetch (the session's network)
 * @param {string | null} [options.appOrigin]  the only origin the responses are shared with
 * @param {string | null} [options.userAgent]
 */
function createMediaServer(options) {
  const {
    getRecord,
    root,
    ffmpegPath = () => null,
    fetchImpl = globalThis.fetch,
    appOrigin = null,
    userAgent = null,
    spawn = defaultSpawn,
  } = options;
  // One extraction / image fetch per file at a time.
  const pending = new Map();
  // .avm files opened from the file explorer this run: token → path
  const openedFiles = new Map();

  const dirFor = (id) => path.join(root, id);

  function headers(extra = {}) {
    return {
      ...(appOrigin ? { "access-control-allow-origin": appOrigin } : {}),
      "cross-origin-resource-policy": "cross-origin",
      ...extra,
    };
  }

  function notFound() {
    return new Response("Not found", { status: 404, headers: headers({ "content-type": "text/plain" }) });
  }

  // A completed record whose file is still there: an episode's video, or
  // (chapter) a manga chapter's .avm file.
  function playableFile(id, { chapter = false } = {}) {
    const record = getRecord(id);
    if (record?.status !== "completed" || typeof record.outputPath !== "string") return null;
    if ((record.mediaType === "manga") !== chapter) return null;
    try {
      const stat = fs.statSync(record.outputPath);
      return stat.isFile() ? { record, file: record.outputPath, size: stat.size } : null;
    } catch {
      return null;
    }
  }

  // ── Video ────────────────────────────────────────────────────────────────

  function serveVideo(request, id) {
    const found = playableFile(id);
    if (!found) return notFound();
    const { file, size } = found;
    const range = parseRange(request.headers.get("range"), size);
    const base = { "content-type": "video/mp4", "accept-ranges": "bytes", "cache-control": "no-store" };
    if (range === "unsatisfiable") {
      return new Response(null, { status: 416, headers: headers({ ...base, "content-range": `bytes */${size}` }) });
    }
    if (request.method === "HEAD") {
      return new Response(null, { status: 200, headers: headers({ ...base, "content-length": String(size) }) });
    }
    if (!range) {
      return new Response(fileStream(file), {
        status: 200,
        headers: headers({ ...base, "content-length": String(size) }),
      });
    }
    const { start, end } = range;
    return new Response(fileStream(file, { start, end }), {
      status: 206,
      headers: headers({
        ...base,
        "content-length": String(end - start + 1),
        "content-range": `bytes ${start}-${end}/${size}`,
      }),
    });
  }

  // ── Chapters ─────────────────────────────────────────────────────────────

  function serveChapter(request, id) {
    const found = playableFile(id, { chapter: true });
    if (!found) return notFound();
    const base = { "content-type": "application/octet-stream", "cache-control": "no-store" };
    if (request.method === "HEAD") {
      return new Response(null, { status: 200, headers: headers({ ...base, "content-length": String(found.size) }) });
    }
    return new Response(fileStream(found.file), {
      status: 200,
      headers: headers({ ...base, "content-length": String(found.size) }),
    });
  }

  // ── Files opened from the file explorer ─────────────────────────────────

  /**
   * An .avm file the system asked the app to open (a double-click): checked
   * (its extension, its "AVM1" mark, its size), then readable by the page as
   * aniverse-media://opened/<token> for as long as the app runs. Null when it
   * isn't one.
   */
  function openFile(filePath) {
    try {
      if (typeof filePath !== "string" || !/\.avm$/i.test(filePath)) return null;
      const resolved = path.resolve(filePath);
      const stat = fs.statSync(resolved);
      if (!stat.isFile() || stat.size < 9 || stat.size > MAX_AVM_BYTES) return null;
      const fd = fs.openSync(resolved, "r");
      const mark = Buffer.alloc(4);
      try {
        fs.readSync(fd, mark, 0, 4, 0);
      } finally {
        fs.closeSync(fd);
      }
      if (mark.toString("latin1") !== "AVM1") return null;
      for (const [token, known] of openedFiles) if (known === resolved) return token;
      const token = crypto.randomUUID();
      openedFiles.set(token, resolved);
      return token;
    } catch {
      return null;
    }
  }

  function serveOpened(request, token) {
    const file = openedFiles.get(token);
    if (!file) return notFound();
    let size;
    try {
      size = fs.statSync(file).size;
    } catch {
      return notFound();
    }
    const base = { "content-type": "application/octet-stream", "cache-control": "no-store", "content-length": String(size) };
    if (request.method === "HEAD") return new Response(null, { status: 200, headers: headers(base) });
    return new Response(fileStream(file), { status: 200, headers: headers(base) });
  }

  // ── Subtitles ────────────────────────────────────────────────────────────

  function sidecarFor(id, index) {
    const dir = dirFor(id);
    for (const format of Object.keys(SUBTITLE_TYPES)) {
      const file = path.join(dir, `sub-${index}.${format}`);
      if (fs.existsSync(file)) return { file, format };
    }
    return null;
  }

  // The mp4's index-th subtitle stream → WebVTT text (null when ffmpeg can't).
  function extractSubtitle(file, index) {
    const bin = ffmpegPath();
    if (!bin) return Promise.resolve(null);
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(
          bin,
          ["-v", "error", "-nostdin", "-i", file, "-map", `0:s:${index}`, "-c:s", "webvtt", "-f", "webvtt", "pipe:1"],
          { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
        );
      } catch {
        resolve(null);
        return;
      }
      const chunks = [];
      let bytes = 0;
      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => {
        child.kill();
        done(null);
      }, EXTRACT_TIMEOUT_MS);
      timer.unref?.();
      child.stdout.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_SUBTITLE_BYTES) {
          child.kill();
          done(null);
          return;
        }
        chunks.push(chunk);
      });
      child.on("error", () => done(null));
      child.on("close", (code) => {
        const text = Buffer.concat(chunks).toString("utf8");
        done(code === 0 && /^﻿?\s*WEBVTT/.test(text) ? text : null);
      });
    });
  }

  async function subtitleFile(id, index) {
    const existing = sidecarFor(id, index);
    if (existing) return existing;
    const found = playableFile(id);
    if (!found || index >= (found.record.subtitles?.length ?? 0)) return null;
    const key = `sub:${id}:${index}`;
    if (!pending.has(key)) {
      pending.set(
        key,
        extractSubtitle(found.file, index)
          .then((text) => {
            if (text === null) return null;
            const file = path.join(dirFor(id), `sub-${index}.vtt`);
            fs.mkdirSync(dirFor(id), { recursive: true });
            fs.writeFileSync(file, text, "utf8");
            return { file, format: "vtt" };
          })
          .catch(() => null)
          .finally(() => pending.delete(key)),
      );
    }
    return pending.get(key);
  }

  async function serveSubtitle(id, index) {
    const sub = await subtitleFile(id, index);
    if (!sub) return notFound();
    return new Response(fileStream(sub.file), {
      status: 200,
      headers: headers({
        "content-type": `${SUBTITLE_TYPES[sub.format]}; charset=utf-8`,
        "cache-control": "no-store",
      }),
    });
  }

  // ── Images ───────────────────────────────────────────────────────────────

  function cachedImage(id, kind) {
    let names;
    try {
      names = fs.readdirSync(dirFor(id));
    } catch {
      return null;
    }
    const name = names.find((n) => n.startsWith(`${kind}.`) && EXTENSION_TYPES[n.slice(kind.length + 1)]);
    return name ? { file: path.join(dirFor(id), name), type: EXTENSION_TYPES[name.slice(kind.length + 1)] } : null;
  }

  async function downloadImage(id, kind) {
    const record = getRecord(id);
    // A chapter's poster is its manga's cover
    const source = kind === "anime" ? (record?.anime?.image ?? record?.manga?.image) : record?.episode?.image;
    if (typeof source !== "string" || !/^https?:\/\//i.test(source)) return null;
    const response = await fetchImpl(source, {
      headers: userAgent ? { "user-agent": userAgent } : {},
      signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
    });
    const type = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    const ext = IMAGE_TYPES[type];
    if (!response.ok || !ext) return null;
    const declared = Number(response.headers.get("content-length"));
    if (declared > MAX_IMAGE_BYTES) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) return null;
    // The record may have been removed meanwhile
    if (!getRecord(id)) return null;
    fs.mkdirSync(dirFor(id), { recursive: true });
    const file = path.join(dirFor(id), `${kind}.${ext}`);
    fs.writeFileSync(file, bytes);
    return { file, type };
  }

  function imageFile(id, kind) {
    const existing = cachedImage(id, kind);
    if (existing) return Promise.resolve(existing);
    if (!getRecord(id)) return Promise.resolve(null);
    const key = `img:${id}:${kind}`;
    if (!pending.has(key)) {
      pending.set(
        key,
        downloadImage(id, kind)
          .catch(() => null)
          .finally(() => pending.delete(key)),
      );
    }
    return pending.get(key);
  }

  async function serveImage(id, kind) {
    const image = await imageFile(id, kind);
    if (!image) return notFound();
    return new Response(fileStream(image.file), {
      status: 200,
      headers: headers({ "content-type": image.type, "cache-control": "max-age=86400" }),
    });
  }

  // ── Public API ───────────────────────────────────────────────────────────

  /** The scheme's handler (protocol.handle): never throws. */
  async function handle(request) {
    try {
      if (request.method !== "GET" && request.method !== "HEAD") return notFound();
      const target = parseMediaUrl(request.url);
      if (!target) return notFound();
      if (target.kind === "video") return serveVideo(request, target.id);
      if (target.kind === "chapter") return serveChapter(request, target.id);
      if (target.kind === "opened") return serveOpened(request, target.id);
      if (target.kind === "subtitle") return await serveSubtitle(target.id, target.index);
      return await serveImage(target.id, target.image);
    } catch (err) {
      console.warn("[download] media request failed:", err?.message || err);
      return notFound();
    }
  }

  /**
   * What the watch page plays: the video and its subtitle tracks (in the
   * mp4's order, the default one first for VOSTFR), null when the record
   * isn't a completed download whose file is still there.
   */
  function playback(id) {
    if (typeof id !== "string" || !ID.test(id)) return null;
    const found = playableFile(id);
    if (!found) return null;
    const { record } = found;
    const subtitles = Array.isArray(record.subtitles) ? record.subtitles : [];
    return {
      id,
      video: videoUrl(id),
      subtitles: subtitles.map((sub, index) => ({
        url: subtitleUrl(id, index),
        locale: sub.locale,
        label: sub.label,
        // The muxer's default track (ffmpeg.js): the first one, VOSTFR only
        default: index === 0 && record.language === "sub",
      })),
    };
  }

  /**
   * A download just finished: its subtitles' original text (the request's)
   * is kept, so the page gets them as they were (ASS styles included).
   */
  function saveSidecars(record, request) {
    if (!ID.test(record?.id ?? "") || record.status !== "completed") return;
    const subtitles = Array.isArray(request?.subtitles) ? request.subtitles : [];
    if (!subtitles.length) return;
    try {
      fs.mkdirSync(dirFor(record.id), { recursive: true });
      subtitles.forEach((sub, index) => {
        if (!SUBTITLE_TYPES[sub.format] || typeof sub.content !== "string") return;
        fs.writeFileSync(path.join(dirFor(record.id), `sub-${index}.${sub.format}`), sub.content, "utf8");
      });
    } catch (err) {
      console.warn("[download] could not keep the subtitles:", err.message);
    }
  }

  /** Fetches the posters of these records now (online), for the offline pages. */
  async function warmImages(records) {
    for (const record of records) {
      if (record?.status !== "completed" || !ID.test(record.id ?? "")) continue;
      for (const kind of IMAGE_KINDS) await imageFile(record.id, kind);
    }
  }

  /** The record is gone: its kept subtitles and posters go too. */
  function forget(id) {
    if (typeof id !== "string" || !ID.test(id)) return;
    try {
      fs.rmSync(dirFor(id), { recursive: true, force: true });
    } catch (_) {}
  }

  return { handle, playback, saveSidecars, warmImages, forget, openFile };
}

module.exports = {
  SCHEME,
  createMediaServer,
  parseRange,
  parseMediaUrl,
  videoUrl,
  subtitleUrl,
  imageUrl,
  chapterUrl,
};
