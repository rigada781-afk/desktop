// ─── mp4 track flags ─────────────────────────────────────────────────────────
// ffmpeg's mp4 muxer enables the first subtitle track when none has the
// default disposition, so a VF file would show its French subtitles by
// default. This clears the "enabled" bit of the subtitle tracks' tkhd in
// place (one byte per track, the file size does not change).

const fs = require("fs");

const SUBTITLE_HANDLERS = new Set(["sbtl", "text", "subt"]);
const MAX_MOOV_BYTES = 64 * 1024 * 1024;

function readHeader(buf, offset, end) {
  if (offset + 8 > end) return null;
  let size = buf.readUInt32BE(offset);
  const type = buf.toString("latin1", offset + 4, offset + 8);
  let header = 8;
  if (size === 1) {
    if (offset + 16 > end) return null;
    size = Number(buf.readBigUInt64BE(offset + 8));
    header = 16;
  } else if (size === 0) {
    size = end - offset;
  }
  if (size < header || offset + size > end) return null;
  return { type, start: offset, size, body: offset + header };
}

function children(buf, start, end) {
  const boxes = [];
  for (let offset = start; offset < end; ) {
    const box = readHeader(buf, offset, end);
    if (!box) break;
    boxes.push(box);
    offset += box.size;
  }
  return boxes;
}

// Top-level boxes read from the file (mdat is skipped, never loaded).
function findMoov(fd, fileSize) {
  const head = Buffer.alloc(16);
  for (let offset = 0; offset + 8 <= fileSize; ) {
    fs.readSync(fd, head, 0, 16, offset);
    let size = head.readUInt32BE(0);
    const type = head.toString("latin1", 4, 8);
    if (size === 1) size = Number(head.readBigUInt64BE(8));
    else if (size === 0) size = fileSize - offset;
    if (size < 8) return null;
    if (type === "moov") return { offset, size };
    offset += size;
  }
  return null;
}

/** Returns how many subtitle tracks were disabled. */
function disableSubtitleTracks(file) {
  const fd = fs.openSync(file, "r+");
  try {
    const { size: fileSize } = fs.fstatSync(fd);
    const moov = findMoov(fd, fileSize);
    if (!moov || moov.size > MAX_MOOV_BYTES) return 0;
    const buf = Buffer.alloc(moov.size);
    fs.readSync(fd, buf, 0, moov.size, moov.offset);
    const root = readHeader(buf, 0, buf.length);
    if (!root) return 0;

    let changed = 0;
    for (const trak of children(buf, root.body, buf.length).filter((b) => b.type === "trak")) {
      const parts = children(buf, trak.body, trak.start + trak.size);
      const tkhd = parts.find((b) => b.type === "tkhd");
      const mdia = parts.find((b) => b.type === "mdia");
      if (!tkhd || !mdia) continue;
      const hdlr = children(buf, mdia.body, mdia.start + mdia.size).find((b) => b.type === "hdlr");
      if (!hdlr || hdlr.body + 12 > hdlr.start + hdlr.size) continue;
      // hdlr: version/flags (4), pre_defined (4), handler_type (4)
      const handler = buf.toString("latin1", hdlr.body + 8, hdlr.body + 12);
      if (!SUBTITLE_HANDLERS.has(handler)) continue;
      // tkhd: version (1), flags (3); bit 0x000001 = track enabled
      const flagsByte = tkhd.body + 3;
      if (buf[flagsByte] & 0x01) {
        const value = Buffer.from([buf[flagsByte] & ~0x01]);
        fs.writeSync(fd, value, 0, 1, moov.offset + flagsByte);
        changed++;
      }
    }
    return changed;
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { disableSubtitleTracks };
