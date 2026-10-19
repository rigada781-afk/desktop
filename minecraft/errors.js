// ─── Modpack errors ──────────────────────────────────────────────────────────
// Every failure the site can show carries a stable code:
//   offline            manifest / files unreachable
//   invalid-manifest   manifest broken or unsafe (bad path, duplicate, …)
//   update-required    manifest format newer than this app
//   hash-mismatch      a downloaded file does not match its size / sha1
//   blocked-host       a file url outside the allowed hosts
//   disk-full          not enough free space
//   game-running       Minecraft is running from this install (files locked)
//   launcher-not-found the chosen launcher is not installed
//   loader-unsupported the launcher cannot install this mod loader
//   java-not-found     no Java 21+ to run the NeoForge installer
//   loader-failed      the loader install failed
//   install-timeout    Modrinth App did not create the instance in time
//   not-installed      unknown install id
//   busy               another modpack job is running
//   cancelled          cancelled by the user / app quit

class ModpackError extends Error {
  constructor(code, message, options) {
    super(message || code, options);
    this.name = "ModpackError";
    this.code = code;
  }
}

function isAbort(err) {
  return !!err && (err.name === "AbortError" || err.code === "ABORT_ERR" || err.code === "cancelled");
}

const NETWORK_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

/** Any thrown value → an error code for the site. */
function errorCode(err) {
  if (err instanceof ModpackError) return err.code;
  if (isAbort(err)) return "cancelled";
  const code = err?.code || err?.cause?.code;
  if (code === "ENOSPC") return "disk-full";
  if (code === "EBUSY" || code === "EPERM") return "game-running";
  if (NETWORK_CODES.has(code)) return "offline";
  if (err?.name === "TimeoutError") return "offline";
  if (err instanceof TypeError && /fetch failed/i.test(err.message)) return "offline";
  return "unknown";
}

module.exports = { ModpackError, errorCode, isAbort };
