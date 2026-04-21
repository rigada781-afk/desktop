// ─── Vumeto Auto-Updater ──────────────────────────────────────────────────────
// Uses electron-updater (works with GitHub Releases, S3, etc.)
// Configure your publish target in package.json > build > publish

const { autoUpdater } = require("electron-updater");
const { dialog, BrowserWindow } = require("electron");
const config = require("./config");

let updateCheckTimer = null;

function setupAutoUpdater(mainWindow) {
  if (!config.AUTO_UPDATE) return;

  // ── Logging ──────────────────────────────────────────────────────────────────
  autoUpdater.logger = console;
  autoUpdater.autoDownload = true; // download silently in background
  autoUpdater.autoInstallOnAppQuit = true; // install when app quits

  // ── Events ───────────────────────────────────────────────────────────────────
  autoUpdater.on("checking-for-update", () => {
    console.log("[updater] Checking for update...");
  });

  autoUpdater.on("update-available", (info) => {
    console.log(`[updater] Update available: ${info.version}`);
    // Notify renderer
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("update-available", {
        version: info.version,
      });
    }
  });

  autoUpdater.on("update-not-available", () => {
    console.log("[updater] App is up to date.");
  });

  autoUpdater.on("download-progress", (progress) => {
    const msg = `[updater] Downloaded ${Math.round(progress.percent)}%`;
    console.log(msg);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("update-download-progress", {
        percent: Math.round(progress.percent),
        bytesPerSecond: progress.bytesPerSecond,
        transferred: progress.transferred,
        total: progress.total,
      });
    }
  });

  autoUpdater.on("update-downloaded", (info) => {
    console.log(`[updater] Update downloaded: ${info.version}`);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("update-downloaded", {
        version: info.version,
      });
    }
    // showUpdateReadyDialog(mainWindow, info.version);
  });

  autoUpdater.on("error", (err) => {
    console.error("[updater] Error:", err.message);
  });

  // ── Initial check + periodic polling ─────────────────────────────────────────
  // Wait 10 seconds after launch before first check (give app time to settle)
  setTimeout(() => {
    autoUpdater
      .checkForUpdates()
      .catch((e) => console.error("[updater]", e.message));
  }, 10_000);

  updateCheckTimer = setInterval(() => {
    autoUpdater
      .checkForUpdates()
      .catch((e) => console.error("[updater]", e.message));
  }, config.UPDATE_CHECK_INTERVAL);
}

function installUpdate() {
  autoUpdater.quitAndInstall();
}

function showUpdateReadyDialog(mainWindow, newVersion) {
  const focusedWindow = BrowserWindow.getFocusedWindow() || mainWindow;
  dialog
    .showMessageBox(focusedWindow, {
      type: "info",
      title: "Update Ready",
      message: `Vumeto ${newVersion} has been downloaded.`,
      detail: "Restart the app to apply the update.",
      buttons: ["Restart Now", "Later"],
      defaultId: 0,
      cancelId: 1,
    })
    .then(({ response }) => {
      if (response === 0) {
        autoUpdater.quitAndInstall();
      }
    });
}

function stopUpdateTimer() {
  if (updateCheckTimer) {
    clearInterval(updateCheckTimer);
    updateCheckTimer = null;
  }
}

module.exports = { setupAutoUpdater, stopUpdateTimer, installUpdate };
