// ─── System helpers: platform paths, child processes, running games ──────────

const os = require("os");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const { ModpackError } = require("./errors");

/** Where each OS keeps per-user app data (injected in tests). */
function systemEnv({ platform = process.platform, home = os.homedir(), env = process.env } = {}) {
  const appData = env.APPDATA || path.join(home, "AppData", "Roaming");
  const localAppData = env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  const xdgData = env.XDG_DATA_HOME || path.join(home, ".local", "share");
  const macSupport = path.join(home, "Library", "Application Support");
  return { platform, home, appData, localAppData, xdgData, macSupport, env };
}

async function exists(p) {
  try {
    await fs.promises.access(p);
    return true;
  } catch (_) {
    return false;
  }
}

/** Runs a program without a shell → { code, stdout, stderr }. Aborted by `signal`, killed after `timeoutMs`. */
function run(cmd, args, { cwd, signal, timeoutMs = 10 * 60_000, onLine } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const child = spawn(cmd, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const take = (chunk, into) => {
      const text = chunk.toString();
      if (onLine) text.split(/\r?\n/).filter(Boolean).forEach(onLine);
      return (into + text).slice(-64 * 1024);
    };
    child.stdout.on("data", (c) => (stdout = take(c, stdout)));
    child.stderr.on("data", (c) => (stderr = take(c, stderr)));
    const kill = () => child.kill();
    signal?.addEventListener("abort", kill, { once: true });
    const timer = setTimeout(kill, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", kill);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", kill);
      if (signal?.aborted) return reject(signal.reason);
      resolve({ code, stdout, stderr });
    });
  });
}

/** Starts a program on its own (it outlives the app, nothing waits for it): resolves once it has started. */
function spawnDetached(cmd, args = []) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    } catch (err) {
      return reject(err);
    }
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

/**
 * Starts the first program found among `candidates` ({ cmd, args, requires }): one with an absolute `cmd`
 * (or a `requires` path) only when that file exists, a bare name when it is on PATH. -> the one started, or null.
 */
async function startFirst(candidates, start = spawnDetached) {
  for (const c of candidates) {
    const needed = c.requires || (path.isAbsolute(c.cmd) ? c.cmd : null);
    if (needed && !(await exists(needed))) continue;
    try {
      await start(c.cmd, c.args || []);
      return c;
    } catch (err) {
      if (err?.code === "ENOENT" || err?.code === "EACCES") continue;
      throw err;
    }
  }
  return null;
}

/** Command lines of running Java processes (empty when they cannot be listed). */
async function javaCommandLines({ platform = process.platform, runImpl = run } = {}) {
  try {
    if (platform === "win32") {
      const script =
        "Get-CimInstance Win32_Process -Filter \"Name like 'java%'\" | ForEach-Object { $_.CommandLine }";
      const r = await runImpl("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { timeoutMs: 20_000 });
      return r.stdout.split(/\r?\n/).filter(Boolean);
    }
    const r = await runImpl("ps", ["-axww", "-o", "args="], { timeoutMs: 20_000 });
    return r.stdout.split(/\n/).filter((l) => /java/i.test(l));
  } catch (_) {
    return [];
  }
}

/** True when a Java process runs with this game directory (launchers pass it as --gameDir). */
async function isGameRunning(gameDir, { platform = process.platform, runImpl = run } = {}) {
  const norm = (s) => {
    const x = s.replace(/\\/g, "/").replace(/\/+$/, "");
    return platform === "linux" ? x : x.toLowerCase();
  };
  const dir = norm(path.resolve(gameDir));
  const lines = await javaCommandLines({ platform, runImpl });
  return lines.some((l) => norm(l).includes(dir));
}

/** Throws ModpackError("game-running") when Minecraft runs from gameDir. */
async function assertGameClosed(gameDir, deps) {
  if (await isGameRunning(gameDir, deps)) throw new ModpackError("game-running", "Minecraft is running from this install");
}

module.exports = { systemEnv, exists, run, spawnDetached, startFirst, isGameRunning, assertGameClosed };
