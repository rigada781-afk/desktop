// Modules to control application life and create native browser window
import { app, BrowserWindow, Tray, Menu, ipcMain } from "electron";
import electronUpdater from "electron-updater";
import log from "electron-log";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isMac = process.platform === "darwin";
const UPDATE_FLAG = path.join(app.getPath("userData"), "update.json");
const autoUpdater = electronUpdater.autoUpdater;

log.initialize();
Object.assign(console, log.functions);
Menu.setApplicationMenu(null);

let mainWindow = null;
let tray = null;
let isQuitting = false;

if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient("vumeto-desktop", process.execPath, [
      path.resolve(process.argv[1]),
    ]);
  }
} else {
  app.setAsDefaultProtocolClient("vumeto-desktop");
}

function showWindow() {
  if (!mainWindow) {
    const wins = BrowserWindow.getAllWindows();
    if (wins.length === 0) {
      createWindow();
    } else {
      wins[0].focus();
    }
  } else {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
}

function createTray() {
  tray = new Tray(path.join(__dirname, "/assets/icons/transparant/16.png"));
  tray.setToolTip("Vumeto");

  const contextMenu = Menu.buildFromTemplate([
    {
      label: "Open App",
      click: () => showWindow(),
    },
    { role: "quit" },
  ]);
  tray.setContextMenu(contextMenu);

  tray.on("click", () => {
    showWindow();
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    icon: path.join(__dirname, "assets/icons/filled/icon.ico"),
    backgroundColor: "#000000",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
    },
  });

  mainWindow.loadURL("https://vumeto.samy0f.com");

  mainWindow.on("close", (event) => {
    if (!isMac && !isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  // Open the DevTools.
  // mainWindow.webContents.openDevTools()
}

function initializeApp() {
  createWindow();
  createTray();
  autoUpdater.autoDownload = true;
  autoUpdater.checkForUpdates();

  if (fs.existsSync(UPDATE_FLAG)) {
    fs.unlinkSync(UPDATE_FLAG);
    autoUpdater.quitAndInstall();
  }
}

const gotTheLock = app.requestSingleInstanceLock();

if (!isMac) {
  if (!gotTheLock) {
    app.quit();
  } else {
    app.on("second-instance", (event, argv, workingDirectory) => {
      // Someone tried to run a second instance, we should focus our window.
      showWindow();

      const deepLink = argv.find((arg) => arg.startsWith("vumeto-desktop://"));

      if (deepLink) {
        const path = deepLink.split("vumeto-desktop://")[1];

        log.info(`Received deep link: ${deepLink}, path: ${path}`);
        mainWindow.webContents.send("deep-link", { path, deepLink });
      }
    });

    app.whenReady().then(() => {
      initializeApp();
    });
  }
} else {
  app.whenReady().then(() => {
    initializeApp();
  });
}

app.on("window-all-closed", () => {
  // Do not call app.quit() here
  console.log("All windows closed, but app is still running.");
  console.log(BrowserWindow.getAllWindows().length);
});

app.on("before-quit", () => {
  isQuitting = true;
});

app.on("activate", function () {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

/* Update Check */

autoUpdater.on("checking-for-update", () => {
  log.info("Checking for update...");
});

autoUpdater.on("update-available", () => {
  log.info("Update available");
});

autoUpdater.on("update-not-available", () => {
  log.info("Update not available");
});

autoUpdater.on("error", (error) => {
  log.error("Error checking for update", error);
});

autoUpdater.on("download-progress", (progress) => {
  log.info(
    `Download progress: ${progress.percent}% (${progress.bytesPerSecond} bytes/s)`
  );
  ipcMain.send("update-download-progress", progress);
});

autoUpdater.on("update-downloaded", () => {
  log.info("Update downloaded");
  update.state = "update-downloaded";
  fs.writeFileSync(UPDATE_FLAG, "ready");

  if (mainWindow) {
    mainWindow.webContents.send("update-ready");
  }
});

ipcMain.handle("install-update", () => {
  isQuitting = true;
  fs.unlinkSync(UPDATE_FLAG);
  autoUpdater.quitAndInstall();
});
