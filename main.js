// ─── Vumeto Desktop — Main Process ───────────────────────────────────────────

const {
  app,
  BrowserWindow,
  shell,
  ipcMain,
  Tray,
  Menu,
  nativeImage,
} = require("electron");
const Store = require("electron-store");
const path = require("path");
const {
  startExpressServer,
  setMainWindow,
  buildUserAgent,
  buildExtraHeaders,
} = require("./server");
const {
  setupAutoUpdater,
  stopUpdateTimer,
  installUpdate,
} = require("./updater");
const { startDiscordRPC, updateDiscordRPC } = require("./rpc");
const {
  initDownload,
  downloadM3U8ToMP4,
  getDownloads,
  pauseDownload,
  resumeDownload,
  cancelDownload,
  deleteDownload,
} = require("./download");
const config = require("./config");

// ── App version ───────────────────────────────────────────────────────────────
const APP_VERSION = app.getVersion();
const IS_DEV = process.argv.includes("--dev");

// ── Single instance lock ──────────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

// ── Store ───────────────────────────────────────────────────────────────

const store = new Store();

// ── Deep link protocol registration ──────────────────────────────────────────
// On macOS this is handled via Info.plist (electron-builder sets it up).
// On Windows/Linux we explicitly register the protocol handler.
//
// NOTE: In development (electron .) Windows will sometimes launch Electron
// with the deep link URL as the "app path" which makes Electron try to load
// the URL as if it were a JS file. To avoid that, we register the protocol
// client with the same args used for normal startup (app path).
let initialDeepLink = null;

function parseDeepLinkFromArgs(argv) {
  return argv?.find((arg) => arg.startsWith(`${config.DEEP_LINK_PROTOCOL}://`));
}

if (process.platform !== "darwin") {
  initialDeepLink = parseDeepLinkFromArgs(process.argv);

  const protocolArgs = [];
  if (process.defaultApp && process.argv.length >= 2) {
    // In dev mode (electron .) we need to pass the app path so Windows can
    // launch us correctly when the protocol is invoked.
    protocolArgs.push(process.argv[1]);
  }

  app.setAsDefaultProtocolClient(
    config.DEEP_LINK_PROTOCOL,
    process.execPath,
    protocolArgs,
  );
}

// ── Startup: launch express server immediately ────────────────────────────────
// This runs even before the window is created, so the site can detect the app.
let expressServer = null;
startExpressServer(APP_VERSION)
  .then((server) => {
    expressServer = server;
  })
  .catch((err) => console.error("[main] Failed to start express server:", err));

// ── Window management ─────────────────────────────────────────────────────────
let mainWindow = null;
let tray = null;

function createWindow(basePath = null) {
  mainWindow = new BrowserWindow({
    width: config.WINDOW.width,
    height: config.WINDOW.height,
    minWidth: config.WINDOW.minWidth,
    minHeight: config.WINDOW.minHeight,
    title: config.WINDOW.title,
    icon: path.join(__dirname, "assets/icons/filled/icon.ico"),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, "preload.js"),
    },
    show: false, // Show after ready-to-show to avoid flicker
    titleBarStyle: "hidden",
    backgroundColor: "#000000",
    ...(process.platform !== "darwin" && {
      titleBarOverlay: {
        color: "#0c0c0c00",
        symbolColor: "#ffffff",
        height: 32,
      },
    }),
  });

  // Show once content is ready
  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  // ── Inject custom headers on every request ──────────────────────────────────
  const filter = { urls: ["*://*/*"] };
  mainWindow.webContents.session.webRequest.onBeforeSendHeaders(
    { urls: ["*://*/*"] },
    (details, callback) => {
      const headers = { ...details.requestHeaders };

      // Always inject desktop identification headers
      headers[config.CUSTOM_HEADER_NAME] = config.CUSTOM_HEADER_VALUE;
      headers["User-Agent"] = buildUserAgent(APP_VERSION);

      // Check for vumeto-headers in the request URL search params
      let redirectURL;
      try {
        const parsedUrl = new URL(details.url);
        const encodedHeaders = parsedUrl.searchParams.get("vumeto-headers");
        if (encodedHeaders) {
          // Parse and inject each header directly (no browser restrictions here)
          const extraHeaders = JSON.parse(decodeURIComponent(encodedHeaders));
          for (const [key, value] of Object.entries(extraHeaders)) {
            headers[key] = value;
          }
          // Strip the param so it never reaches the actual server
          parsedUrl.searchParams.delete("vumeto-headers");
          redirectURL = parsedUrl.toString();
        }
      } catch (e) {
        console.warn(
          "[headers] Failed to parse vumeto-headers param:",
          e.message,
        );
      }

      callback({
        requestHeaders: headers,
        ...(redirectURL ? { redirectURL } : {}),
      });
    },
  );
  // ── CORS bypass: remove restrictive response headers ────────────────────────
  mainWindow.webContents.session.webRequest.onHeadersReceived(
    filter,
    (details, callback) => {
      const headers = { ...details.responseHeaders };
      // Override CORS headers to allow everything
      headers["access-control-allow-origin"] = ["*"];
      headers["access-control-allow-headers"] = ["*"];
      headers["access-control-allow-methods"] = [
        "GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD",
      ];
      headers["access-control-allow-credentials"] = ["true"];
      callback({ responseHeaders: headers });
    },
  );

  const url = basePath ? `${config.APP_URL}${basePath}` : config.APP_URL;
  console.log("[main] Loading URL:", url);

  // ── Load the app URL ─────────────────────────────────────────────────────────
  mainWindow.loadURL(url, {
    extraHeaders: buildExtraHeaders(APP_VERSION),
  });

  // ── Open external links in default browser ───────────────────────────────────
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(config.APP_URL)) {
      shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });

  // ── Tray icon ─────────────────────────────────────────────────────────────────
  setupTray();

  // ── Register with express server ─────────────────────────────────────────────
  setMainWindow(mainWindow, goToPath);

  // ── Auto-updater ──────────────────────────────────────────────────────────────
  setupAutoUpdater(mainWindow);

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // On close: minimize to tray instead of quitting
  // mainWindow.on("close", (e) => {
  //   if (!app.isQuitting) {
  //     e.preventDefault();
  //     mainWindow.hide();
  //   }
  // });

  if (IS_DEV) mainWindow.webContents.openDevTools();

  return mainWindow;
}

const goToPath = (path) => {
  if (path.startsWith(config.APP_URL)) {
    path = path.replace(config.APP_URL, "");
  }
  if (!path.startsWith("/")) {
    path = `/${path}`;
  }

  try {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();

      // Optionally navigate to a specific path
      if (path) {
        const targetUrl = `${config.APP_URL}${path}`;
        mainWindow.loadURL(targetUrl, {
          extraHeaders: buildExtraHeaders(APP_VERSION),
        });
      }
      return true;
    }
  } catch (error) {}
  createWindow(path);
  return true;
};

function setupTray() {
  try {
    if (tray) return;

    const iconPath = path.join(
      __dirname,
      "assets",
      "icons",
      "transparant",
      "16.png",
    );
    const icon = nativeImage.createFromPath(iconPath);
    tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
    tray.setToolTip("Vumeto");
    const contextMenu = Menu.buildFromTemplate([
      {
        label: "Open Vumeto",
        click: () => {
          if (mainWindow) {
            mainWindow.show();
            mainWindow.focus();
          } else {
            createWindow();
          }
        },
      },
      { type: "separator" },
      {
        label: `Version ${APP_VERSION}`,
        enabled: false,
      },
      { type: "separator" },
      {
        label: "Quit",
        click: () => {
          app.isQuitting = true;
          app.quit();
        },
      },
    ]);
    tray.setContextMenu(contextMenu);
    tray.on("click", () => {
      if (mainWindow) {
        mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
      } else {
        createWindow();
      }
    });
  } catch (e) {
    console.warn("[tray] Could not create tray icon:", e.message);
  }
}

// ── Deep link handler ─────────────────────────────────────────────────────────
function handleDeepLink(url) {
  if (!url) return;

  // Parse: vumeto://action?param=value
  try {
    const parsed = new URL(url);
    const action = parsed.hostname; // e.g. "open", "auth", "page"
    const params = Object.fromEntries(parsed.searchParams.entries());

    const path = action === "open" ? params.path : null;

    goToPath(path);
  } catch (e) {
    console.error("[deeplink] Failed to parse URL:", e.message);
  }
}

// ── Second instance (Windows/Linux deep link) ─────────────────────────────────
app.on("second-instance", (_event, commandLine) => {
  // The deep link URL is the last argument on Windows/Linux
  const url = commandLine.find((arg) =>
    arg.startsWith(`${config.DEEP_LINK_PROTOCOL}://`),
  );
  if (url) handleDeepLink(url);

  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

// ── macOS deep link ───────────────────────────────────────────────────────────
app.on("open-url", (event, url) => {
  event.preventDefault();
  handleDeepLink(url);
});

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  startDiscordRPC();
  // Only show window if NOT launched at startup (startup = hidden/background mode)
  const isStartup =
    process.argv.includes("--startup") ||
    (app.getLoginItemSettings && app.getLoginItemSettings().wasOpenedAtLogin);

  if (!isStartup) {
    createWindow();
  } else {
    console.log(
      "[main] Launched at startup — running in background (express only)",
    );
    // Tray-only mode at startup
    try {
      setupTray();
    } catch (e) {
      console.warn("[main] Tray setup failed at startup:", e.message);
    }
  }
  initDownload(mainWindow, store);

  // If the app was launched via deep link (Windows/Linux), handle it now.
  if (initialDeepLink) {
    handleDeepLink(initialDeepLink);
    initialDeepLink = null;
  }

  // ── Set app to run at system startup ────────────────────────────────────────
  if (!IS_DEV) {
    app.setLoginItemSettings({
      openAtLogin: true,
      openAsHidden: true, // Start minimized/hidden (background only)
      args: ["--startup"],
    });
  }

  app.on("activate", () => {
    // macOS: re-open window when dock icon is clicked
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else if (mainWindow) {
      mainWindow.show();
    }
  });
});

app.on("window-all-closed", () => {
  // On macOS keep app running (tray + server), on other platforms too
  // App only truly quits from tray menu
});

app.on("before-quit", () => {
  app.isQuitting = true;
  stopUpdateTimer();
  if (expressServer) {
    expressServer.close(() => console.log("[express] Server closed"));
  }
});

// ── IPC handlers ──────────────────────────────────────────────────────────────
ipcMain.handle("get-app-version", () => APP_VERSION);
ipcMain.handle("get-platform", () => process.platform);
ipcMain.handle("open-external", (_, url) => shell.openExternal(url));
ipcMain.handle("open-devtools", () => mainWindow?.webContents?.openDevTools());
ipcMain.handle("install-update", () => installUpdate());
ipcMain.handle("show-window", () => {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  }
});
ipcMain.handle("minimize", () => mainWindow?.minimize());
ipcMain.handle("maximize", () => mainWindow?.maximize());
ipcMain.handle("unmaximize", () => mainWindow?.unmaximize());
ipcMain.handle("close", () => mainWindow?.close());
ipcMain.handle("reload", () => mainWindow?.webContents?.reload());
ipcMain.handle("force-reload", () =>
  mainWindow?.webContents?.reloadIgnoringCache(),
);
ipcMain.handle("update-discord-rpc", (_, { name, episode, id }) =>
  updateDiscordRPC({ name, episode, id }),
);

ipcMain.handle("download:start", (_, masterUrl, metadata) =>
  downloadM3U8ToMP4(masterUrl, metadata),
);
ipcMain.handle("download:history", () => getDownloads());
ipcMain.handle("download:pause", (_, id) => pauseDownload(id));
ipcMain.handle("download:resume", (_, id) => resumeDownload(id));
ipcMain.handle("download:cancel", (_, id) => cancelDownload(id));
ipcMain.handle("download:delete", (_, id) => deleteDownload(id));
