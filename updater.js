// ─── Aniverse Auto-Updater ──────────────────────────────────────────────────────
// Uses electron-updater (works with GitHub Releases, S3, etc.)
// Configure your publish target in package.json > build > publish
//
// Set up ONCE (not per window): events go to the current window through a
// getter. A status machine (UpdateStatus) feeds the settings page; the
// title bar keeps its update-available / -download-progress / -downloaded
// events. Dev builds (not packaged) and config.AUTO_UPDATE false are
// "unsupported": electron-updater is never loaded nor called there.

const config = require("./config");

const FIRST_CHECK_DELAY_MS = 10_000;
const STATUS_EVENT = "updates:status";

// Short and without secrets: first line, URLs cut to origin + path.
function shortError(err) {
  const text = String(err?.message || err || "Erreur inconnue").split("\n")[0];
  return text.replace(/https?:\/\/[^\s"')]+/g, (url) => {
    try {
      const parsed = new URL(url);
      return `${parsed.origin}${parsed.pathname}`;
    } catch (_) {
      return "";
    }
  }).slice(0, 200);
}

/**
 * @param {object} options
 * @param {boolean} options.supported  packaged build with config.AUTO_UPDATE
 * @param {() => any} [options.loadAutoUpdater]  electron-updater's autoUpdater (lazy)
 * @param {string} options.currentVersion
 * @param {(channel: string, payload: any) => void} [options.send]  to the current window
 * @param {(channel: string, payload: any) => void} [options.sendToApp]  to the site's pages only
 * @param {{ autoCheckUpdates: boolean, autoDownloadUpdates: boolean, installUpdatesOnQuit: boolean }} [options.settings]
 */
function createUpdater(options) {
  const {
    supported,
    loadAutoUpdater = () => require("electron-updater").autoUpdater,
    currentVersion,
    send = () => {},
    sendToApp = send,
    now = Date.now,
    timers = { setTimeout, clearTimeout, setInterval, clearInterval },
    firstCheckDelayMs = FIRST_CHECK_DELAY_MS,
    checkIntervalMs = config.UPDATE_CHECK_INTERVAL,
    logger = console,
  } = options;

  let settings = {
    autoCheckUpdates: true,
    autoDownloadUpdates: true,
    installUpdatesOnQuit: true,
    ...(options.settings || {}),
  };
  let status = { state: supported ? "idle" : "unsupported", currentVersion };
  let autoUpdater = null;
  let firstCheckTimer = null;
  let intervalTimer = null;

  function getStatus() {
    return { ...status, ...(status.progress ? { progress: { ...status.progress } } : {}) };
  }

  function setStatus(next) {
    status = { currentVersion, ...next };
    for (const key of Object.keys(status)) {
      if (status[key] === undefined) delete status[key];
    }
    try {
      sendToApp(STATUS_EVENT, getStatus());
    } catch (_) {}
  }

  function patchStatus(patch) {
    setStatus({ ...status, ...patch });
  }

  function legacy(channel, payload) {
    try {
      send(channel, payload);
    } catch (_) {}
  }

  // ── electron-updater events → status ────────────────────────────────────

  function wire() {
    autoUpdater.logger = logger;
    autoUpdater.autoDownload = settings.autoDownloadUpdates;
    autoUpdater.autoInstallOnAppQuit = settings.installUpdatesOnQuit;

    autoUpdater.on("checking-for-update", () => {
      logger.log("[updater] Checking for update...");
      setStatus({ state: "checking", version: status.version, lastCheckedAt: status.lastCheckedAt });
    });

    autoUpdater.on("update-available", (info) => {
      logger.log(`[updater] Update available: ${info?.version}`);
      // With autoDownload the download starts right after this event.
      setStatus({
        state: autoUpdater.autoDownload ? "downloading" : "available",
        version: info?.version,
        lastCheckedAt: now(),
        ...(autoUpdater.autoDownload
          ? { progress: { percent: 0, bytesPerSecond: 0, transferred: 0, total: 0 } }
          : {}),
      });
      legacy("update-available", { version: info?.version });
    });

    autoUpdater.on("update-not-available", () => {
      logger.log("[updater] App is up to date.");
      setStatus({ state: "not-available", lastCheckedAt: now() });
    });

    autoUpdater.on("download-progress", (progress) => {
      const data = {
        percent: Math.round(Number(progress?.percent) || 0),
        bytesPerSecond: Number(progress?.bytesPerSecond) || 0,
        transferred: Number(progress?.transferred) || 0,
        total: Number(progress?.total) || 0,
      };
      logger.log(`[updater] Downloaded ${data.percent}%`);
      setStatus({ state: "downloading", version: status.version, lastCheckedAt: status.lastCheckedAt, progress: data });
      legacy("update-download-progress", data);
    });

    autoUpdater.on("update-downloaded", (info) => {
      logger.log(`[updater] Update downloaded: ${info?.version}`);
      const version = info?.version || status.version;
      setStatus({ state: "downloaded", version, lastCheckedAt: status.lastCheckedAt });
      legacy("update-downloaded", { version });
    });

    autoUpdater.on("error", (err) => {
      logger.error("[updater] Error:", err?.message || err);
      setError(err);
    });
  }

  function setError(err) {
    // A failed check also counts as checked (the page says when it tried).
    const wasChecking = status.state === "checking";
    setStatus({
      state: "error",
      version: status.version,
      error: shortError(err),
      lastCheckedAt: wasChecking ? now() : status.lastCheckedAt,
    });
  }

  // ── Checks ──────────────────────────────────────────────────────────────

  async function runCheck() {
    if (!autoUpdater) return getStatus();
    // Nothing new to find while one runs or before the ready update is installed.
    if (["checking", "downloading", "downloaded"].includes(status.state)) return getStatus();
    try {
      await autoUpdater.checkForUpdates();
    } catch (err) {
      if (status.state !== "error") setError(err);
    }
    return getStatus();
  }

  function autoCheck() {
    runCheck().catch(() => {});
  }

  function stopTimers() {
    if (firstCheckTimer) timers.clearTimeout(firstCheckTimer);
    if (intervalTimer) timers.clearInterval(intervalTimer);
    firstCheckTimer = null;
    intervalTimer = null;
  }

  // The 10 s first check (until one ran) + the periodic ones, while enabled.
  function scheduleChecks() {
    stopTimers();
    if (!autoUpdater || !settings.autoCheckUpdates) return;
    if (status.lastCheckedAt === undefined) {
      firstCheckTimer = timers.setTimeout(() => {
        firstCheckTimer = null;
        autoCheck();
      }, firstCheckDelayMs);
    }
    intervalTimer = timers.setInterval(autoCheck, checkIntervalMs);
  }

  // ── Public API ──────────────────────────────────────────────────────────

  function start() {
    if (!supported || autoUpdater) return;
    try {
      autoUpdater = loadAutoUpdater();
      wire();
    } catch (err) {
      logger.error("[updater] unavailable:", err?.message || err);
      autoUpdater = null;
      setStatus({ state: "unsupported" });
      return;
    }
    scheduleChecks();
  }

  /** Live: autoDownload / autoInstallOnAppQuit / the automatic checks. */
  function applySettings(next) {
    const previous = settings;
    settings = {
      autoCheckUpdates: next?.autoCheckUpdates !== false,
      autoDownloadUpdates: next?.autoDownloadUpdates !== false,
      installUpdatesOnQuit: next?.installUpdatesOnQuit !== false,
    };
    if (!autoUpdater) return;
    autoUpdater.autoDownload = settings.autoDownloadUpdates;
    autoUpdater.autoInstallOnAppQuit = settings.installUpdatesOnQuit;
    // electron-updater adds its install-on-quit handler when the download
    // ends, and only if the option was on then: turned on afterwards, it's
    // added now (once; it reads the option again at quit).
    if (
      settings.installUpdatesOnQuit &&
      !previous.installUpdatesOnQuit &&
      status.state === "downloaded"
    ) {
      autoUpdater.addQuitHandler?.();
    }
    if (settings.autoCheckUpdates !== previous.autoCheckUpdates) scheduleChecks();
    // Turned on while an update waits: fetch it now.
    if (settings.autoDownloadUpdates && !previous.autoDownloadUpdates && status.state === "available") {
      download();
    }
  }

  /** Manual check: works with the automatic checks off. */
  function check() {
    return runCheck();
  }

  /** Starts the download of an available update; progress through the status events. */
  function download() {
    if (!autoUpdater || status.state !== "available") return getStatus();
    patchStatus({
      state: "downloading",
      error: undefined,
      progress: { percent: 0, bytesPerSecond: 0, transferred: 0, total: 0 },
    });
    Promise.resolve()
      .then(() => autoUpdater.downloadUpdate())
      .catch((err) => {
        if (status.state !== "error") setError(err);
      });
    return getStatus();
  }

  function install() {
    if (!autoUpdater) return;
    autoUpdater.quitAndInstall();
  }

  /**
   * A restart asked by the app (Paramètres › Application › Redémarrer) while
   * an update waits to be installed on quit: the quit would run the update's
   * silent installer, which closes the relaunched app and doesn't start it
   * again. So the update installs now, silently, and starts the app after.
   * True when that happens; false: restart as usual (see skipInstallOnQuit).
   */
  function restartWithUpdate() {
    if (!autoUpdater || status.state !== "downloaded" || !settings.installUpdatesOnQuit) return false;
    autoUpdater.quitAndInstall(true, true);
    return true;
  }

  /** The app restarts itself: no install on this quit (the next run installs it). */
  function skipInstallOnQuit() {
    if (autoUpdater) autoUpdater.autoInstallOnAppQuit = false;
  }

  return {
    start,
    applySettings,
    getStatus,
    check,
    download,
    install,
    restartWithUpdate,
    skipInstallOnQuit,
    stop: stopTimers,
  };
}

// ── The app's instance ────────────────────────────────────────────────────────
let updater = null;

/**
 * Called ONCE at startup.
 * @param {object} options
 * @param {() => Electron.BrowserWindow | null} options.getWindow
 * @param {(channel: string, payload: any) => void} options.sendToApp  site pages only
 * @param {boolean} options.isPackaged
 * @param {string} options.currentVersion
 * @param {object} options.settings  the app settings (update keys)
 */
function setupAutoUpdater(options) {
  if (updater) return updater;
  const { getWindow = () => null, sendToApp, isPackaged, currentVersion, settings } = options || {};
  const send = (channel, payload) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };
  updater = createUpdater({
    supported: config.AUTO_UPDATE === true && isPackaged === true,
    currentVersion,
    send,
    sendToApp: sendToApp || send,
    settings,
  });
  updater.start();
  return updater;
}

function applyUpdateSettings(settings) {
  updater?.applySettings(settings);
}

function getUpdateStatus() {
  return updater ? updater.getStatus() : null;
}

function checkForUpdates() {
  return updater ? updater.check() : null;
}

function downloadUpdate() {
  return updater ? updater.download() : null;
}

function installUpdate() {
  updater?.install();
}

/** True when a waiting update installs and restarts the app itself. */
function restartWithUpdate() {
  return updater ? updater.restartWithUpdate() : false;
}

function skipInstallOnQuit() {
  updater?.skipInstallOnQuit();
}

function stopUpdateTimer() {
  updater?.stop();
}

module.exports = {
  setupAutoUpdater,
  applyUpdateSettings,
  getUpdateStatus,
  checkForUpdates,
  downloadUpdate,
  stopUpdateTimer,
  installUpdate,
  restartWithUpdate,
  skipInstallOnQuit,
  createUpdater,
  shortError,
  STATUS_EVENT,
};
