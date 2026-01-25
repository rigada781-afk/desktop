// Modules to control application life and create native browser window
import { app, BrowserWindow, Tray, Menu } from "electron";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isMac = process.platform === "darwin";

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
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
    },
  });

  mainWindow.loadURL("https://vumeto.samy0f.com");
  // mainWindow.loadFile("index.html");

  mainWindow.on("close", (event) => {
    if (!isMac && !isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  // Open the DevTools.
  // mainWindow.webContents.openDevTools()
}

const gotTheLock = app.requestSingleInstanceLock();

if (!isMac) {
  if (!gotTheLock) {
    app.quit();
  } else {
    app.on("second-instance", (event, commandLine, workingDirectory) => {
      // Someone tried to run a second instance, we should focus our window.
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
      }
    });

    app.whenReady().then(() => {
      createWindow();
      createTray();
    });
  }
} else {
  app.whenReady().then(() => {
    createWindow();
    createTray();
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

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
