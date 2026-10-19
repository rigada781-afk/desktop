// ─── Network for the modpack ─────────────────────────────────────────────────
// One fetch for manifests and files: https only, the host must be allowed,
// redirects are followed by hand so every hop is checked, and a request with
// no answer for a while is aborted. A manifest can therefore never make the
// app fetch from an arbitrary host (local network included).

const { ModpackError } = require("./errors");

const USER_AGENT = "AniverseDesktop-Modpack";
const MAX_REDIRECTS = 5;
const HEADERS_TIMEOUT_MS = 30_000;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/**
 * policy: { hosts: Set<string>, allowLoopbackHttp?: boolean }
 * Returns the parsed URL or throws ModpackError("blocked-host").
 */
function checkUrl(input, policy) {
  let url;
  try {
    url = new URL(input);
  } catch (_) {
    throw new ModpackError("blocked-host", "invalid url");
  }
  if (url.username || url.password) throw new ModpackError("blocked-host", "credentials in url");
  const host = url.hostname.toLowerCase();
  if (url.protocol === "https:" && policy.hosts.has(host)) return url;
  if (policy.allowLoopbackHttp && (url.protocol === "http:" || url.protocol === "https:") && LOOPBACK.has(host)) {
    return url;
  }
  throw new ModpackError("blocked-host", `host not allowed: ${url.protocol}//${host}`);
}

function anySignal(signals) {
  return AbortSignal.any(signals.filter(Boolean));
}

/** fetch-like, bound to a policy. Non-2xx answers are returned (callers decide). */
function createFetch(policy, { fetchImpl = (u, init) => fetch(u, init), headersTimeoutMs = HEADERS_TIMEOUT_MS } = {}) {
  return async function guardedFetch(input, init = {}) {
    let url = checkUrl(input, policy);
    const headers = new Headers(init.headers);
    if (!headers.has("user-agent")) headers.set("user-agent", USER_AGENT);
    for (let hop = 0; ; hop++) {
      const timer = new AbortController();
      const t = setTimeout(() => timer.abort(new DOMException("headers timeout", "TimeoutError")), headersTimeoutMs);
      let res;
      try {
        res = await fetchImpl(url, { ...init, headers, redirect: "manual", signal: anySignal([init.signal, timer.signal]) });
      } finally {
        clearTimeout(t);
      }
      if (res.status < 300 || res.status >= 400 || res.status === 304) return res;
      const location = res.headers.get("location");
      if (!location) return res;
      await res.body?.cancel().catch(() => {});
      if (hop >= MAX_REDIRECTS) throw new ModpackError("offline", "too many redirects");
      url = checkUrl(new URL(location, url).toString(), policy);
      headers.delete("authorization");
    }
  };
}

/** GET → text with a size cap; non-2xx throws (404 → offline too: nothing to install from). */
async function getText(guardedFetch, url, { signal, maxBytes = 16 * 1024 * 1024, headers } = {}) {
  const res = await guardedFetch(url, { signal, headers, cache: "no-store" });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new ModpackError("offline", `HTTP ${res.status} for ${new URL(url).host}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) throw new ModpackError("invalid-manifest", "response too large");
  return buf.toString("utf8");
}

module.exports = { USER_AGENT, checkUrl, createFetch, getText };
