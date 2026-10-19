// ─── Segment decryption and checks ───────────────────────────────────────────
// HLS AES-128 is AES-128-CBC with PKCS#7 padding over the whole segment; the
// IV is the key's IV attribute or, without one, the media sequence number as
// a 16-byte big-endian integer.

const crypto = require("crypto");
const { DownloadError } = require("./errors");

function sequenceIv(seq) {
  const iv = Buffer.alloc(16);
  iv.writeBigUInt64BE(BigInt(seq), 8);
  return iv;
}

function segmentIv(key, seq) {
  return key.iv ? key.iv : sequenceIv(seq);
}

function decryptAes128(data, keyBytes, iv) {
  if (!keyBytes || keyBytes.length !== 16) {
    throw new DownloadError("forbidden", "AES-128 key is not 16 bytes");
  }
  try {
    const decipher = crypto.createDecipheriv("aes-128-cbc", keyBytes, iv);
    return Buffer.concat([decipher.update(data), decipher.final()]);
  } catch (_) {
    // A cut body or a wrong key: retried, then reported.
    throw new DownloadError("unsupported", "AES-128 decryption failed", {
      retryable: true,
    });
  }
}

const TS_PACKET = 188;
const MAX_TS_PREFIX = 64 * 1024;

/**
 * Offset of the first MPEG-TS packet: 0 when the segment starts with the
 * 0x47 sync byte, the end of a disguise prefix (fake image header) when three
 * sync bytes line up 188 bytes apart further in, -1 when it is not TS.
 */
function findTsStart(buf) {
  if (!buf?.length) return -1;
  if (buf[0] === 0x47) return 0;
  const limit = Math.min(buf.length - 2 * TS_PACKET, MAX_TS_PREFIX);
  for (let i = 1; i < limit; i++) {
    if (
      buf[i] === 0x47 &&
      buf[i + TS_PACKET] === 0x47 &&
      buf[i + 2 * TS_PACKET] === 0x47
    ) {
      return i;
    }
  }
  return -1;
}

// Packed audio segments (audio renditions without EXT-X-MAP): ID3 or ADTS.
function isPackedAudio(buf) {
  if (!buf || buf.length < 3) return false;
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return true; // "ID3"
  return buf[0] === 0xff && (buf[1] & 0xf6) === 0xf0;
}

module.exports = {
  sequenceIv,
  segmentIv,
  decryptAes128,
  findTsStart,
  isPackedAudio,
};
