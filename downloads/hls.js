// ─── HLS playlists ───────────────────────────────────────────────────────────
// Master / media playlist parsing (RFC 8216 subset a VOD download needs) and
// the local playlist handed to ffmpeg once every segment is on disk.

const { DownloadError } = require("./errors");

function resolveUri(uri, base) {
  return new URL(uri, base).href;
}

function playlistLines(text) {
  return String(text ?? "")
    .replace(/^﻿/, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function isPlaylist(text) {
  return /^﻿?\s*#EXTM3U/.test(String(text ?? ""));
}

function isMasterPlaylist(text) {
  return /#EXT-X-STREAM-INF:/.test(String(text ?? ""));
}

// `BANDWIDTH=1,CODECS="a,b",URI="x"` → { BANDWIDTH: "1", CODECS: "a,b", URI: "x" }
function parseAttributes(input) {
  const attrs = {};
  const re = /(?:^|,)\s*([A-Za-z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(input))) {
    let value = m[2].trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    attrs[m[1].toUpperCase()] = value;
  }
  return attrs;
}

function toInt(value) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}

function parseResolution(value) {
  const m = /^(\d+)x(\d+)$/i.exec(value || "");
  return m ? { width: Number(m[1]), height: Number(m[2]) } : { width: null, height: null };
}

// ── Master playlist ─────────────────────────────────────────────────────────

function parseMaster(text, baseUrl) {
  const variants = [];
  const media = [];
  let pending = null;

  for (const line of playlistLines(text)) {
    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      pending = parseAttributes(line.slice("#EXT-X-STREAM-INF:".length));
      continue;
    }
    if (line.startsWith("#EXT-X-MEDIA:")) {
      const a = parseAttributes(line.slice("#EXT-X-MEDIA:".length));
      media.push({
        type: (a.TYPE || "").toUpperCase(),
        groupId: a["GROUP-ID"] ?? null,
        name: a.NAME ?? null,
        language: a.LANGUAGE ?? null,
        uri: a.URI ? resolveUri(a.URI, baseUrl) : null,
        default: a.DEFAULT === "YES",
        autoselect: a.AUTOSELECT === "YES",
      });
      continue;
    }
    // Other tags, I-FRAME-STREAM-INF included (its URI is an attribute).
    if (line.startsWith("#")) continue;
    if (!pending) continue;
    const { width, height } = parseResolution(pending.RESOLUTION);
    variants.push({
      uri: resolveUri(line, baseUrl),
      bandwidth: toInt(pending.BANDWIDTH) ?? 0,
      averageBandwidth: toInt(pending["AVERAGE-BANDWIDTH"]),
      width,
      height,
      codecs: pending.CODECS ?? null,
      audio: pending.AUDIO ?? null,
    });
    pending = null;
  }

  return { variants, audio: media.filter((m) => m.type === "AUDIO") };
}

/**
 * Highest-bandwidth variant. With maxHeight: the tallest height at or under
 * it, and the highest bandwidth at that height, so a height the quality
 * probe lists is exactly the variant downloaded (a lower height with a
 * higher bandwidth never wins). When nothing fits the cap, the smallest
 * known height (else the lowest bandwidth).
 */
function pickVariant(variants, maxHeight) {
  if (!variants?.length) return null;
  const byBandwidth = [...variants].sort((a, b) => b.bandwidth - a.bandwidth);
  if (!maxHeight) return byBandwidth[0];
  const fitting = byBandwidth.filter((v) => v.height && v.height <= maxHeight);
  if (fitting.length) {
    const height = Math.max(...fitting.map((v) => v.height));
    return fitting.find((v) => v.height === height);
  }
  const known = byBandwidth
    .filter((v) => v.height)
    .sort((a, b) => a.height - b.height || b.bandwidth - a.bandwidth);
  // No variant says its height: the cap can't apply, the best one is taken
  // (as the quality dialog offers it: one "Qualité d’origine").
  return known[0] || byBandwidth[0];
}

/** The variant's AUDIO group rendition to download, or null when muxed. */
function pickAudioRendition(master, variant) {
  if (!variant?.audio) return null;
  const group = master.audio.filter((m) => m.groupId === variant.audio);
  if (!group.length) return null;
  const chosen =
    group.find((m) => m.default) || group.find((m) => m.autoselect) || group[0];
  return chosen.uri ? chosen : null;
}

function qualityLabel(variant) {
  return variant?.height ? `${variant.height}p` : null;
}

// ── Media playlist ──────────────────────────────────────────────────────────

function parseIv(value) {
  const hex = String(value).replace(/^0x/i, "");
  if (!/^[0-9a-f]{1,32}$/i.test(hex)) {
    throw new DownloadError("unsupported", "invalid EXT-X-KEY IV");
  }
  return Buffer.from(hex.padStart(32, "0"), "hex");
}

// "<length>[@<offset>]"
function parseByteRange(value) {
  const m = /^(\d+)(?:@(\d+))?$/.exec(String(value).trim());
  if (!m) throw new DownloadError("unsupported", "invalid BYTERANGE");
  return { length: Number(m[1]), offset: m[2] != null ? Number(m[2]) : null };
}

function parseKey(attrs, baseUrl) {
  const method = (attrs.METHOD || "NONE").toUpperCase();
  if (method === "NONE") return null;
  if (method !== "AES-128") {
    throw new DownloadError("unsupported", `EXT-X-KEY METHOD=${method}`);
  }
  if (attrs.KEYFORMAT && attrs.KEYFORMAT !== "identity") {
    throw new DownloadError("unsupported", `EXT-X-KEY KEYFORMAT=${attrs.KEYFORMAT}`);
  }
  if (!attrs.URI) throw new DownloadError("unsupported", "EXT-X-KEY without URI");
  return {
    method,
    uri: resolveUri(attrs.URI, baseUrl),
    iv: attrs.IV ? parseIv(attrs.IV) : null,
  };
}

/**
 * Returns { segments, mediaSequence, targetDuration, endList, totalDuration }.
 * Each segment: { index, uri, duration, seq, key, map, byteRange,
 * discontinuity }. key: { method, uri, iv|null } | null; map: { uri,
 * byteRange, key } | null; byteRange: { offset, length } | null.
 */
function parseMedia(text, baseUrl) {
  let mediaSequence = 0;
  let targetDuration = null;
  let endList = false;
  let key = null;
  let map = null;
  let duration = null;
  let range = null;
  let discontinuity = false;
  let gap = false;
  let previous = null;
  const segments = [];
  let position = 0; // index in the playlist, gaps included (for the sequence number)

  for (const line of playlistLines(text)) {
    if (line.startsWith("#")) {
      const colon = line.indexOf(":");
      const tag = colon === -1 ? line : line.slice(0, colon);
      const value = colon === -1 ? "" : line.slice(colon + 1);
      switch (tag) {
        case "#EXT-X-MEDIA-SEQUENCE":
          mediaSequence = toInt(value) ?? 0;
          break;
        case "#EXT-X-TARGETDURATION":
          targetDuration = toInt(value);
          break;
        case "#EXT-X-ENDLIST":
          endList = true;
          break;
        case "#EXT-X-KEY":
          key = parseKey(parseAttributes(value), baseUrl);
          break;
        case "#EXT-X-MAP": {
          const a = parseAttributes(value);
          if (!a.URI) throw new DownloadError("unsupported", "EXT-X-MAP without URI");
          let byteRange = null;
          if (a.BYTERANGE) {
            const r = parseByteRange(a.BYTERANGE);
            byteRange = { offset: r.offset ?? 0, length: r.length };
          }
          map = { uri: resolveUri(a.URI, baseUrl), byteRange, key };
          break;
        }
        case "#EXT-X-BYTERANGE":
          range = parseByteRange(value);
          break;
        case "#EXT-X-DISCONTINUITY":
          discontinuity = true;
          break;
        case "#EXT-X-GAP":
          gap = true;
          break;
        case "#EXTINF":
          duration = parseFloat(value.split(",")[0]);
          if (!Number.isFinite(duration) || duration < 0) duration = 0;
          break;
        default:
          break; // PROGRAM-DATE-TIME, BITRATE, ALLOW-CACHE, … are irrelevant here
      }
      continue;
    }

    const uri = resolveUri(line, baseUrl);
    let byteRange = null;
    if (range) {
      let offset = range.offset;
      if (offset == null) {
        // No offset: the range starts right after the previous one of the
        // same resource.
        offset =
          previous && previous.uri === uri && previous.byteRange
            ? previous.byteRange.offset + previous.byteRange.length
            : 0;
      }
      byteRange = { offset, length: range.length };
    }
    const segment = {
      index: segments.length,
      uri,
      duration: duration ?? 0,
      seq: mediaSequence + position,
      key,
      map,
      byteRange,
      discontinuity,
    };
    position++;
    // A GAP segment has no media: skip it (the next one keeps the
    // discontinuity so ffmpeg does not stitch the timestamps).
    if (!gap) {
      segments.push(segment);
      discontinuity = false;
    }
    previous = segment;
    duration = null;
    range = null;
    gap = false;
  }

  const totalDuration = segments.reduce((sum, s) => sum + s.duration, 0);
  return { segments, mediaSequence, targetDuration, endList, totalDuration };
}

// ── Local playlist ──────────────────────────────────────────────────────────

function formatDuration(seconds) {
  return Number(seconds.toFixed(6)).toString();
}

/**
 * entries: [{ file, duration, discontinuity?, mapFile? }] with file names
 * relative to the playlist. The data is already decrypted and sliced, so no
 * KEY or BYTERANGE lines.
 */
function buildLocalPlaylist(entries) {
  const maxDuration = entries.reduce((m, e) => Math.max(m, e.duration), 1);
  const lines = [
    "#EXTM3U",
    `#EXT-X-VERSION:${entries.some((e) => e.mapFile) ? 6 : 3}`,
    `#EXT-X-TARGETDURATION:${Math.ceil(maxDuration)}`,
    "#EXT-X-MEDIA-SEQUENCE:0",
    "#EXT-X-PLAYLIST-TYPE:VOD",
  ];
  let currentMap = null;
  entries.forEach((entry, i) => {
    if (entry.discontinuity && i > 0) lines.push("#EXT-X-DISCONTINUITY");
    if (entry.mapFile && entry.mapFile !== currentMap) {
      lines.push(`#EXT-X-MAP:URI="${entry.mapFile}"`);
      currentMap = entry.mapFile;
    }
    lines.push(`#EXTINF:${formatDuration(entry.duration)},`, entry.file);
  });
  lines.push("#EXT-X-ENDLIST");
  return `${lines.join("\n")}\n`;
}

module.exports = {
  resolveUri,
  isPlaylist,
  isMasterPlaylist,
  parseAttributes,
  parseMaster,
  pickVariant,
  pickAudioRendition,
  qualityLabel,
  parseIv,
  parseByteRange,
  parseMedia,
  buildLocalPlaylist,
};
