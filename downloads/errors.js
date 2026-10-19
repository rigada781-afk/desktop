// ─── Download errors ─────────────────────────────────────────────────────────
// Every failure ends as one of the contract's error codes. The site turns the
// code into a French label; `message` is only a technical detail and is
// persisted, so it never carries a URL, a header or a token.

const ERROR_CODES = new Set([
  "network",
  "forbidden",
  "expired",
  "unsupported",
  "disk",
  "ffmpeg",
  "interrupted",
  "unknown",
]);

// fs / OS error codes that mean "the disk or the folder is the problem".
const DISK_CODES = new Set([
  "ENOSPC",
  "EDQUOT",
  "EACCES",
  "EPERM",
  "EROFS",
  "EBUSY",
  "EIO",
  "ENOENT",
  "ENOTDIR",
  "EISDIR",
  "EEXIST",
  "ENAMETOOLONG",
  "EMFILE",
  "ENFILE",
  "EXDEV",
]);

const MAX_MESSAGE = 2000;

class DownloadError extends Error {
  /**
   * @param {string} code  one of ERROR_CODES
   * @param {string} message  technical detail (no URL / token)
   * @param {{ retryable?: boolean, status?: number, retryAfterMs?: number }} [opts]
   */
  constructor(code, message, opts = {}) {
    super(message);
    this.name = "DownloadError";
    this.code = ERROR_CODES.has(code) ? code : "unknown";
    this.retryable = !!opts.retryable;
    if (opts.status) this.status = opts.status;
    if (opts.retryAfterMs != null) this.retryAfterMs = opts.retryAfterMs;
  }
}

// Abort reasons used on a job's signals: "cancel" (user), "pause" (user,
// the in-flight request is redone on resume) and "interrupt" (app quit).
function abortError(kind) {
  const err = new Error(kind);
  err.name = "AbortError";
  err.kind = kind;
  return err;
}

function isAbortError(err) {
  return !!err && (err.name === "AbortError" || err.kind != null);
}

function truncate(text) {
  const value = String(text ?? "");
  return value.length > MAX_MESSAGE ? value.slice(-MAX_MESSAGE) : value;
}

/** Turns any thrown value into the record's `error` field. */
function toRecordError(err) {
  if (err instanceof DownloadError) {
    return { code: err.code, message: truncate(err.message) };
  }
  if (err && typeof err.code === "string" && DISK_CODES.has(err.code)) {
    return { code: "disk", message: truncate(err.message) };
  }
  return { code: "unknown", message: truncate(err?.message || err) };
}

module.exports = {
  ERROR_CODES,
  DownloadError,
  abortError,
  isAbortError,
  toRecordError,
};
