// ─── Download request validation ─────────────────────────────────────────────
// The request comes from a remote page: every field is type- and
// length-checked and copied into a fresh object (unknown fields, a folder or
// a path are never taken).

const MAX_TITLE = 300;
const MAX_URL = 8192;
const MAX_SUBTITLES = 8;
const MAX_SUBTITLE_BYTES = 5 * 1024 * 1024;
const MAX_HEADERS = 32;
const MAX_HEADER_VALUE = 8192;
const SUBTITLE_FORMATS = new Set(["vtt", "srt", "ass"]);
// How each format's text starts (after an optional BOM and blank lines).
const SUBTITLE_START = {
  vtt: /^﻿?\s*WEBVTT/,
  ass: /^﻿?\s*\[Script Info\]/i,
  srt: /^﻿?\s*\d+\s*\r?\n\s*\d{1,2}:\d{2}:\d{2}[,.]\d{3}\s*-->/,
};
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/;
// Hop-by-hop / transport headers the app sets itself (or fetch refuses).
const DROPPED_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "keep-alive",
  "upgrade",
  "te",
  "trailer",
  "expect",
  "range",
  "accept-encoding",
]);

function isPlainObject(value) {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function optionalString(value, max) {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== "string" || value.length > max) return { ok: false };
  const trimmed = value.trim();
  return { ok: true, value: trimmed || null };
}

function requiredString(value, max) {
  if (typeof value !== "string") return { ok: false };
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) return { ok: false };
  return { ok: true, value: trimmed };
}

function httpUrl(value) {
  if (typeof value !== "string" || !value || value.length > MAX_URL) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

// Images are only stored for the site to show: http(s) or nothing.
function optionalImage(value) {
  if (value === undefined || value === null || value === "") return { ok: true, value: null };
  if (typeof value !== "string" || value.length > MAX_URL) return { ok: false };
  return { ok: true, value: httpUrl(value) ? value : null };
}

function validateHeaders(value) {
  if (value === undefined || value === null) return { ok: true, value: {} };
  if (!isPlainObject(value)) return { ok: false };
  const entries = Object.entries(value);
  if (entries.length > MAX_HEADERS) return { ok: false };
  const headers = {};
  for (const [name, raw] of entries) {
    if (!HEADER_NAME.test(name)) return { ok: false };
    if (typeof raw !== "string" || raw.length > MAX_HEADER_VALUE) return { ok: false };
    if (/[\r\n\0]/.test(raw)) return { ok: false };
    if (DROPPED_HEADERS.has(name.toLowerCase()) || name.toLowerCase().startsWith("proxy-")) {
      continue;
    }
    headers[name] = raw;
  }
  return { ok: true, value: headers };
}

function validateSubtitles(value) {
  if (value === undefined || value === null) return { ok: true, value: [] };
  if (!Array.isArray(value) || value.length > MAX_SUBTITLES) return { ok: false };
  const subtitles = [];
  for (const sub of value) {
    if (!isPlainObject(sub)) return { ok: false };
    const locale = requiredString(sub.locale, 35);
    const label = requiredString(sub.label, 100);
    if (!locale.ok || !/^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{1,8})*$/.test(locale.value)) {
      return { ok: false };
    }
    if (!label.ok || !SUBTITLE_FORMATS.has(sub.format)) return { ok: false };
    if (typeof sub.content !== "string") return { ok: false };
    if (Buffer.byteLength(sub.content, "utf8") > MAX_SUBTITLE_BYTES) return { ok: false };
    // Not the subtitle text it claims to be: left out, the episode still downloads.
    if (!SUBTITLE_START[sub.format].test(sub.content)) continue;
    if (sub.default !== undefined && typeof sub.default !== "boolean") return { ok: false };
    subtitles.push({
      locale: locale.value,
      label: label.value,
      format: sub.format,
      content: sub.content,
      default: sub.default === true,
    });
  }
  return { ok: true, value: subtitles };
}

/**
 * source / kind / headers, as start() and the quality probe take them.
 * @returns {{ ok: true, stream: { source: string, kind: "hls" | "mp4", headers: object } }
 *   | { ok: false, reason: string }}
 */
function validateStream(raw) {
  const fail = (reason) => ({ ok: false, reason });
  if (!isPlainObject(raw)) return fail("request");

  const source = httpUrl(raw.source);
  if (!source) return fail("source");

  if (raw.kind !== undefined && raw.kind !== null && raw.kind !== "hls" && raw.kind !== "mp4") {
    return fail("kind");
  }
  const kind = raw.kind || (/\.(mp4|m4v)$/i.test(source.pathname) ? "mp4" : "hls");

  const headers = validateHeaders(raw.headers);
  if (!headers.ok) return fail("headers");

  // As given: signed CDN URLs must not be re-encoded.
  return { ok: true, stream: { source: raw.source, kind, headers: headers.value } };
}

/**
 * @returns {{ ok: true, request: object } | { ok: false, reason: string }}
 * The normalized request keeps `headers` in memory only (never persisted).
 */
function validateRequest(raw) {
  const fail = (reason) => ({ ok: false, reason });
  const stream = validateStream(raw);
  if (!stream.ok) return stream;
  const { source, kind, headers } = stream.stream;

  let maxHeight = null;
  if (raw.maxHeight !== undefined && raw.maxHeight !== null) {
    if (!Number.isInteger(raw.maxHeight) || raw.maxHeight <= 0 || raw.maxHeight > 10_000) {
      return fail("maxHeight");
    }
    maxHeight = raw.maxHeight;
  }

  if (!isPlainObject(raw.anime)) return fail("anime");
  const animeId = requiredString(raw.anime.id, 200);
  const animeTitle = requiredString(raw.anime.title, MAX_TITLE);
  const slug = optionalString(raw.anime.slug, MAX_TITLE);
  const animeImage = optionalImage(raw.anime.image);
  if (!animeId.ok || !animeTitle.ok || !slug.ok || !animeImage.ok) return fail("anime");
  if (raw.anime.isMovie !== undefined && typeof raw.anime.isMovie !== "boolean") {
    return fail("anime");
  }

  if (!isPlainObject(raw.episode)) return fail("episode");
  const number = raw.episode.number;
  if (typeof number !== "number" || !Number.isFinite(number) || number < 0 || number > 100_000) {
    return fail("episode");
  }
  const episodeTitle = optionalString(raw.episode.title, MAX_TITLE);
  const episodeImage = optionalImage(raw.episode.image);
  if (!episodeTitle.ok || !episodeImage.ok) return fail("episode");

  if (raw.language !== "sub" && raw.language !== "dub") return fail("language");

  const watchPath = requiredString(raw.watchPath, 2048);
  if (
    !watchPath.ok ||
    !watchPath.value.startsWith("/") ||
    watchPath.value.startsWith("//") ||
    /[\\\s]/.test(watchPath.value)
  ) {
    return fail("watchPath");
  }

  const subtitles = validateSubtitles(raw.subtitles);
  if (!subtitles.ok) return fail("subtitles");
  // The default track goes first: it is the one marked default in the mp4.
  subtitles.value.sort((a, b) => Number(b.default) - Number(a.default));

  return {
    ok: true,
    request: {
      source,
      kind,
      headers,
      maxHeight,
      anime: {
        id: animeId.value,
        title: animeTitle.value,
        slug: slug.value,
        image: animeImage.value,
        isMovie: raw.anime.isMovie === true,
      },
      episode: {
        number,
        title: episodeTitle.value,
        image: episodeImage.value,
      },
      language: raw.language,
      watchPath: watchPath.value,
      subtitles: subtitles.value,
    },
  };
}

module.exports = {
  validateRequest,
  validateStream,
  MAX_TITLE,
  MAX_SUBTITLES,
  MAX_SUBTITLE_BYTES,
};
