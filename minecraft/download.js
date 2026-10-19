// ─── File downloads for the modpack ──────────────────────────────────────────
// One file: streamed to a `.part` file while its sha1 is computed, checked
// against the manifest's size and sha1, then renamed over the destination (a
// crash leaves the old file or the new one, never half of one). Retries with
// backoff; an idle transfer is aborted. A pool runs several at once and stops
// everything on the first failure.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { once } = require("events");
const { ModpackError, isAbort } = require("./errors");

const DEFAULT_BACKOFF = [1000, 3000, 9000];

class Retryable extends Error {}
class Mismatch extends Error {}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function closeStream(ws) {
  if (ws.closed) return;
  await new Promise((resolve) => ws.end(resolve));
}

/**
 * item: { id, url, dest, part, size, sha1 }
 * opts: { fetch, signal, onBytes(delta), attempts = 3, backoffMs(attempt), idleTimeoutMs = 30 s }
 */
async function downloadFile(item, opts) {
  const attempts = Math.max(1, opts.attempts ?? 3);
  const backoff = opts.backoffMs ?? ((n) => DEFAULT_BACKOFF[Math.min(n - 1, 2)]);
  const idleMs = opts.idleTimeoutMs ?? 30_000;
  let counted = 0;
  const setCounted = (n) => {
    if (n !== counted) opts.onBytes?.(n - counted);
    counted = n;
  };

  async function transfer() {
    const req = new AbortController();
    const onAbort = () => req.abort(opts.signal.reason);
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    let idle = null;
    const armIdle = () => {
      clearTimeout(idle);
      idle = setTimeout(() => req.abort(new Retryable("idle timeout")), idleMs);
    };
    let ws = null;
    try {
      armIdle();
      const res = await opts.fetch(item.url, { signal: req.signal });
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        if ([401, 403, 404, 410].includes(res.status)) {
          throw new ModpackError("offline", `HTTP ${res.status} for ${item.id}`);
        }
        throw new Retryable(`HTTP ${res.status}`);
      }
      if (!res.body) throw new Retryable("empty body");
      await fs.promises.mkdir(path.dirname(item.part), { recursive: true });
      const hash = crypto.createHash("sha1");
      ws = fs.createWriteStream(item.part);
      const wsError = once(ws, "error").then(([e]) => {
        throw e;
      });
      wsError.catch(() => {});
      let written = 0;
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await Promise.race([reader.read(), wsError]);
        if (done) break;
        armIdle();
        written += value.byteLength;
        if (written > item.size) {
          await reader.cancel().catch(() => {});
          throw new Mismatch("too large");
        }
        hash.update(value);
        if (!ws.write(value)) await Promise.race([once(ws, "drain"), wsError]);
        setCounted(written);
      }
      await closeStream(ws);
      ws = null;
      if (written < item.size) throw new Retryable("connection closed early");
      if (hash.digest("hex") !== item.sha1) throw new Mismatch("sha1");
      await fs.promises.mkdir(path.dirname(item.dest), { recursive: true });
      await fs.promises.rename(item.part, item.dest);
    } catch (err) {
      if (ws) {
        ws.destroy();
        await once(ws, "close").catch(() => {});
      }
      await fs.promises.rm(item.part, { force: true }).catch(() => {});
      setCounted(0);
      if (opts.signal?.aborted) throw opts.signal.reason ?? err;
      if (req.signal.aborted && req.signal.reason instanceof Retryable) throw req.signal.reason;
      throw err;
    } finally {
      clearTimeout(idle);
      opts.signal?.removeEventListener("abort", onAbort);
    }
  }

  let mismatches = 0;
  let lastErr = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await transfer();
      return;
    } catch (err) {
      if (opts.signal?.aborted || (isAbort(err) && !(err instanceof Retryable))) throw opts.signal?.reason ?? err;
      if (err instanceof ModpackError) throw err;
      if (err instanceof Mismatch) mismatches++;
      lastErr = err;
    }
    if (attempt < attempts) await sleep(backoff(attempt), opts.signal);
  }
  if (mismatches > 0) throw new ModpackError("hash-mismatch", `${item.id} does not match the manifest`);
  throw new ModpackError("offline", `download failed for ${item.id}`, { cause: lastErr });
}

/** Runs fn over items with at most `limit` at once; the first failure aborts the rest and is rethrown. */
async function runPool(items, limit, fn, signal) {
  const inner = new AbortController();
  const onOuter = () => inner.abort(signal.reason);
  if (signal?.aborted) throw signal.reason;
  signal?.addEventListener("abort", onOuter, { once: true });
  let next = 0;
  let first = null;
  const worker = async () => {
    while (next < items.length && first === null && !inner.signal.aborted) {
      const item = items[next++];
      try {
        await fn(item, inner.signal);
      } catch (err) {
        if (first === null) {
          first = err;
          inner.abort(err);
        }
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  } finally {
    signal?.removeEventListener("abort", onOuter);
  }
  if (first !== null) throw first;
  if (signal?.aborted) throw signal.reason;
}

module.exports = { downloadFile, runPool, sleep };
