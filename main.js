// Modules to control application life and create native browser window
import { app, BrowserWindow, Tray, Menu, ipcMain, session } from "electron";
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
const isDev = !app.isPackaged;

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

function getAssetPath(...paths) {
  if (!isDev) {
    return path.join(process.resourcesPath, ...paths);
  }
  return path.join(__dirname, ...paths);
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
  const iconPath = getAssetPath("assets", "icons", "transparant", "16.png");

  tray = new Tray(iconPath);
  tray.setToolTip(`Vumeto v${app.getVersion()}`);

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
    titleBarStyle: "hidden",

    ...(!isMac
      ? {
          titleBarOverlay: {
            color: "#0c0c0c00",
            symbolColor: "#ffffff",
            height: 32,
          },
        }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
    },
  });

  mainWindow.loadURL("https://vumeto.samy0f.com/home", {
    extraHeaders: "x-app: desktop\n",
  });
  // mainWindow.loadURL("http://localhost:3000/home", {
  //   extraHeaders: "x-app: desktop\n",
  // });

  mainWindow.webContents.setUserAgent(
    `VumetoDesktop/${app.getVersion()} ${mainWindow.webContents.getUserAgent()}`
  );

  mainWindow.on("close", (event) => {
    if (!isMac && !isQuitting) {
      ipcMain?.send?.("window-close");
      event.preventDefault();
      mainWindow.hide();
    }
  });

  // Open the DevTools.
  if (isDev) {
    mainWindow.webContents.openDevTools();
  }
}

function initializeApp() {
  createWindow();
  createTray();

  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    try {
      const url = new URL(details.url);
      const ref = url.searchParams.get("vumeto-ref");

      if (ref) {
        const decodedRef = decodeURIComponent(ref);

        details.requestHeaders["Referer"] = decodedRef;
        details.requestHeaders["Origin"] = decodedRef;
      }
    } catch (e) {
      log.error("Failed to parse URL:", details.url, e);
    }

    callback({ requestHeaders: details.requestHeaders });
  });

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const headers = {
      ...details.responseHeaders,
    };

    // Remove existing CORS headers (important)
    delete headers["access-control-allow-origin"];
    delete headers["Access-Control-Allow-Origin"];

    headers["Access-Control-Allow-Origin"] = ["*"];
    headers["Access-Control-Allow-Headers"] = ["*"];
    headers["Access-Control-Allow-Methods"] = [
      "GET, POST, PUT, DELETE, OPTIONS",
    ];

    callback({ responseHeaders: headers });
  });

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

ipcMain.handle("get-app-version", () => {
  return app.getVersion();
});
