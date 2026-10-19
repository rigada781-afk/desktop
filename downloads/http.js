// ─── HTTP for downloads ──────────────────────────────────────────────────────
// Global fetch with an idle timeout, retries with backoff (honouring
// Retry-After), status and HTML-body checks. Every request is aborted by the
// job's signal (cancel / pause / quit).

const fs = require("fs");
const { DownloadError, abortError } = require("./errors");

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_ATTEMPTS = 5;
const BACKOFF_MS = [500, 1000, 2000, 4000];
const MAX_RETRY_AFTER_MS = 30_000;

function isRetryableStatus(status) {
  return status === 403 || status === 408 || status === 429 || status >= 500;
}

// Final error code for a non-2xx answer (once the retries are spent).
function codeForStatus(status) {
  if (status === 401 || status === 403) return "forbidden";
  if (status === 404 || status === 410) return "expired";
  return "network";
}

function parseRetryAfter(value, now = Date.now()) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  }
  const date = Date.parse(value);
  if (Number.isFinite(date)) {
    return Math.min(Math.max(0, date - now), MAX_RETRY_AFTER_MS);
  }
  return null;
}

// True when the first non-blank byte is "<" (an HTML error / block page).
function looksLikeHtml(buf) {
  let i = 0;
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) i = 3;
  for (; i < Math.min(buf.length, 256); i++) {
    const b = buf[i];
    if (b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d) continue;
    return b === 0x3c;
  }
  return false;
}

/** The headers to try, in order: as given, without Origin, without Referer too. */
function headerFallbacks(headers = {}) {
  const sets = [headers];
  for (const name of ["origin", "referer"]) {
    const last = sets[sets.length - 1];
    if (Object.keys(last).some((key) => key.toLowerCase() === name)) {
      sets.push(
        Object.fromEntries(Object.entries(last).filter(([key]) => key.toLowerCase() !== name)),
      );
    }
  }
  return sets;
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return "?";
  }
}

function abortReason(signal) {
  const reason = signal?.reason;
  return reason instanceof Error ? reason : abortError("cancel");
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortReason(signal));
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    function onAbort() {
      clearTimeout(timer);
      reject(abortReason(signal));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * @param {{ fetch?: typeof fetch, sleep?: typeof sleep, timeoutMs?: number, attempts?: number }} [deps]
 */
function createHttp(deps = {}) {
  const fetchImpl = deps.fetch || ((...args) => globalThis.fetch(...args));
  const wait = deps.sleep || sleep;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const attempts = deps.attempts ?? DEFAULT_ATTEMPTS;

  // One attempt with an idle timer: the answer and every body chunk must
  // arrive within `timeoutMs`, so a stalled socket can never hang a job.
  async function attempt(url, opts, consume) {
    const controller = new AbortController();
    const outer = opts.signal;
    const onOuterAbort = () => controller.abort(abortReason(outer));
    if (outer?.aborted) throw abortReason(outer);
    outer?.addEventListener("abort", onOuterAbort, { once: true });

    let timedOut = false;
    let timer = null;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort(abortError("timeout"));
      }, timeoutMs);
    };

    arm();
    try {
      const res = await fetchImpl(url, {
        headers: opts.headers || {},
        signal: controller.signal,
        redirect: "follow",
      });
      arm();
      if (!res.ok && !(opts.allowStatus && opts.allowStatus(res.status))) {
        try {
          await res.body?.cancel();
        } catch (_) {}
        throw new DownloadError(
          codeForStatus(res.status),
          `HTTP ${res.status} (${hostOf(url)})`,
          {
            retryable: isRetryableStatus(res.status),
            status: res.status,
            retryAfterMs: parseRetryAfter(res.headers.get("retry-after")),
          },
        );
      }
      return await consume(res, arm);
    } catch (err) {
      if (outer?.aborted) throw abortReason(outer);
      if (timedOut) {
        throw new DownloadError("network", `timeout (${hostOf(url)})`, {
          retryable: true,
        });
      }
      if (err instanceof DownloadError) throw err;
      // Writing the file (disk full, folder not writable): not the network,
      // not worth retrying; toRecordError reports it as "disk". Fetch failures
      // carry their syscall on err.cause, never on err itself.
      if (typeof err?.syscall === "string") throw err;
      const cause = err?.cause?.code || err?.code;
      throw new DownloadError(
        "network",
        `${err?.message || "fetch failed"}${cause ? ` ${cause}` : ""} (${hostOf(url)})`,
        { retryable: true },
      );
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onOuterAbort);
    }
  }

  /**
   * run(headers) is called with the request's headers, then with fewer after
   * a refusal: some hosts refuse what they serve to a plainer request (zoko's
   * segment CDN keeps cached 403s for requests with an Origin, while the same
   * segment comes back without it). After a 401/403 the next set is tried at
   * once: without Origin, then without Referer too (Authorization and the rest
   * always stay); each new attempt starts again with every header.
   */
  async function withRetries(url, opts, run) {
    const sets = headerFallbacks(opts.headers);
    let set = 0;
    for (let i = 0; ; ) {
      try {
        return await run(sets[set]);
      } catch (err) {
        if (!(err instanceof DownloadError)) throw err;
        if ((err.status === 401 || err.status === 403) && set < sets.length - 1) {
          set++;
          continue;
        }
        if (!err.retryable || i >= attempts - 1) throw err;
        const delay =
          err.retryAfterMs ?? BACKOFF_MS[Math.min(i, BACKOFF_MS.length - 1)];
        await wait(delay, opts.signal);
        set = 0;
        i++;
      }
    }
  }

  async function readBody(res, arm, onChunk) {
    if (!res.body) return Buffer.alloc(0);
    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      arm();
      chunks.push(value);
      size += value.byteLength;
      onChunk?.(value.byteLength);
    }
    return Buffer.concat(
      chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)),
      size,
    );
  }

  /**
   * GET a body as a Buffer.
   * opts.checkHtml: "body" (default) rejects an HTML body or content-type,
   *   "header" only the content-type (encrypted bodies start with any byte).
   * opts.transform(buf, res): validates / converts the body; a DownloadError
   *   it throws with retryable: true is retried like a network error.
   */
  function getBuffer(url, opts = {}) {
    const checkHtml = opts.checkHtml ?? "body";
    return withRetries(url, opts, (headers) =>
      attempt(url, { ...opts, headers }, async (res, arm) => {
        const body = await readBody(res, arm, opts.onChunk);
        const type = res.headers.get("content-type") || "";
        if (
          checkHtml &&
          (/text\/html/i.test(type) || (checkHtml === "body" && looksLikeHtml(body)))
        ) {
          throw new DownloadError(
            "forbidden",
            `HTML answer instead of media (${hostOf(url)})`,
            { retryable: true },
          );
        }
        return opts.transform ? opts.transform(body, res) : body;
      }),
    );
  }

  async function getText(url, opts = {}) {
    const buf = await getBuffer(url, opts);
    return buf.toString("utf8");
  }

  /**
   * A resource's size from a one-byte ranged GET: the Content-Range total,
   * or the Content-Length when the server ignores Range (the body is then
   * cancelled unread). Resolves null when the answer gives neither.
   */
  function getSize(url, opts = {}) {
    return withRetries(url, opts, (headers) =>
      attempt(url, { ...opts, headers: { ...headers, Range: "bytes=0-0" } }, async (res) => {
        let size = null;
        if (res.status === 206) {
          const m = /\/(\d+)\s*$/.exec(res.headers.get("content-range") || "");
          if (m) size = Number(m[1]);
        } else {
          const length = Number(res.headers.get("content-length"));
          if (Number.isFinite(length) && length > 0) size = length;
        }
        await res.body?.cancel().catch(() => {});
        if (/text\/html/i.test(res.headers.get("content-type") || "")) {
          throw new DownloadError(
            "forbidden",
            `HTML answer instead of media (${hostOf(url)})`,
            { retryable: true },
          );
        }
        return size;
      }),
    );
  }

  /**
   * Streams a file to disk, resuming with Range after a dropped connection
   * (and after a pause: call it again with the same path).
   * Returns { size, total } (total null when the server sent no length).
   */
  function downloadToFile(url, filePath, opts = {}) {
    return withRetries(url, opts, (requestHeaders) => {
      let start = 0;
      try {
        start = fs.statSync(filePath).size;
      } catch (_) {}
      const headers = { ...requestHeaders };
      if (start > 0) headers.Range = `bytes=${start}-`;

      return attempt(
        url,
        { ...opts, headers, allowStatus: (s) => s === 416 && start > 0 },
        async (res, arm) => {
          if (res.status === 416) {
            // Nothing left to read: the file is already complete.
            const total = Number(
              /\/(\d+)\s*$/.exec(res.headers.get("content-range") || "")?.[1],
            );
            if (total === start) return { size: start, total };
            throw new DownloadError("network", "range not satisfiable", {
              retryable: false,
            });
          }
          const append = start > 0 && res.status === 206;
          let size = append ? start : 0;
          let total = null;
          if (res.status === 206) {
            const m = /\/(\d+)\s*$/.exec(res.headers.get("content-range") || "");
            if (m) total = Number(m[1]);
          } else {
            const length = Number(res.headers.get("content-length"));
            if (Number.isFinite(length) && length > 0) total = length;
          }
          if (total) opts.onTotal?.(total);
          const type = res.headers.get("content-type") || "";
          if (/text\/html/i.test(type)) {
            await res.body?.cancel().catch(() => {});
            throw new DownloadError(
              "forbidden",
              `HTML answer instead of media (${hostOf(url)})`,
              { retryable: true },
            );
          }

          const handle = await fs.promises.open(filePath, append ? "a" : "w");
          try {
            const reader = res.body.getReader();
            let first = !append;
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              arm();
              const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
              if (first) {
                first = false;
                if (looksLikeHtml(chunk)) {
                  throw new DownloadError(
                    "forbidden",
                    `HTML answer instead of media (${hostOf(url)})`,
                    { retryable: true },
                  );
                }
              }
              await handle.write(chunk);
              size += chunk.length;
              opts.onChunk?.(chunk.length, size);
            }
          } finally {
            await handle.close();
          }
          if (total && size < total) {
            throw new DownloadError("network", `incomplete body (${hostOf(url)})`, {
              retryable: true,
            });
          }
          return { size, total };
        },
      );
    });
  }

  return { getBuffer, getText, getSize, downloadToFile };
}

module.exports = {
  createHttp,
  sleep,
  looksLikeHtml,
  parseRetryAfter,
  isRetryableStatus,
  codeForStatus,
  DEFAULT_TIMEOUT_MS,
  BACKOFF_MS,
};
