// ─── Aniverse Desktop — Main Process ───────────────────────────────────────────

const {
  app,
  BrowserWindow,
  dialog,
  shell,
  ipcMain,
  net,
  screen,
  session,
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
  applyUpdateSettings,
  getUpdateStatus,
  checkForUpdates,
  downloadUpdate,
  stopUpdateTimer,
  installUpdate,
  restartWithUpdate,
  skipInstallOnQuit,
} = require("./updater");
const {
  startDiscordRPC,
  configureDiscordRPC,
  updateDiscordRPC,
  clearDiscordRPC,
} = require("./rpc");
const {
  registerMediaScheme,
  initDownload,
  getDownloadPlayback,
  saveChapter,
  openChapterFile,
  startDownload,
  probeDownloadQualities,
  getDownloads,
  pauseDownload,
  resumeDownload,
  cancelDownload,
  deleteDownload,
  openDownloadFile,
  showDownloadInFolder,
  getDownloadFolder,
  chooseDownloadFolder,
  openDownloadFolder,
  setMaxConcurrentDownloads,
  interruptDownloads,
} = require("./download");
const { createSettings, stepZoom, zoomShortcut } = require("./settings");
const { watchServerErrorPages } = require("./page-errors");
const { initMinecraft } = require("./minecraft");
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

// ── App settings (Paramètres › Application on the site) ──────────────────────
const settings = createSettings({
  store,
  info: () => ({
    version: APP_VERSION,
    platform: process.platform,
    isPackaged: app.isPackaged,
  }),
});

// Read before app ready: Chromium decides at startup (a change needs a restart).
if (!settings.get().hardwareAcceleration) {
  app.disableHardwareAcceleration();
}

// Windows notifications are shown under the installer shortcut's AppUserModelID.
if (process.platform === "win32" && app.isPackaged) {
  app.setAppUserModelId(config.APP_USER_MODEL_ID);
}

// Launched by the login item: our --startup arg (Windows), the system (macOS).
function wasLaunchedAtLogin() {
  if (process.argv.includes("--startup")) return true;
  if (process.platform !== "darwin") return false;
  try {
    return app.getLoginItemSettings().wasOpenedAtLogin === true;
  } catch (_) {
    return false;
  }
}

// The first window of a run launched at login opens minimized when asked.
let openMinimized = wasLaunchedAtLogin() && settings.get().startMinimized;

let isPiP = false;

// ── Deep link protocol registration ──────────────────────────────────────────
let initialDeepLink = null;

function parseDeepLinkFromArgs(argv) {
  return argv?.find((arg) => arg.startsWith(`${config.DEEP_LINK_PROTOCOL}://`));
}

if (process.platform !== "darwin") {
  initialDeepLink = parseDeepLinkFromArgs(process.argv);

  const protocolArgs = [];
  if (process.defaultApp && process.argv.length >= 2) {
    protocolArgs.push(process.argv[1]);
  }

  app.setAsDefaultProtocolClient(
    config.DEEP_LINK_PROTOCOL,
    process.execPath,
    protocolArgs,
  );
}

// The downloads' aniverse-media: scheme (the site's /downloads/watch): before ready.
registerMediaScheme();

// ── Startup: launch express server immediately ────────────────────────────────
let expressServer = null;
startExpressServer(APP_VERSION)
  .then((server) => {
    expressServer = server;
  })
  .catch((err) => console.error("[main] Failed to start express server:", err));

// ── Window management ─────────────────────────────────────────────────────────
let mainWindow = null;

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
      zoomFactor: settings.get().zoomFactor,
    },
    show: false,
    frame: false,
    titleBarStyle: "hidden",
    titleBarOverlay: false,
    autoHideMenuBar: true,
    simpleFullscreen: true,
    backgroundColor: "#000000",
  });

  const minimized = openMinimized;
  openMinimized = false;
  mainWindow.once("ready-to-show", () => {
    if (minimized) {
      // In the taskbar; maximized like a normal start once restored.
      if (process.platform !== "win32") mainWindow.showInactive();
      mainWindow.minimize();
      mainWindow.once("restore", () => mainWindow?.maximize());
      return;
    }
    mainWindow.show();
    mainWindow.maximize();
  });

  // ── Interface zoom (settings): on every load; the shortcuts step and save it
  const contents = mainWindow.webContents;
  const applyZoom = () => {
    try {
      if (!contents.isDestroyed()) contents.setZoomFactor(settings.get().zoomFactor);
    } catch (_) {}
  };
  contents.on("did-navigate", applyZoom);
  contents.on("did-finish-load", applyZoom);
  // Window shortcuts (not system-wide): Ctrl+= / Ctrl+- / Ctrl+0
  contents.on("before-input-event", (event, input) => {
    const direction = zoomShortcut(input);
    if (direction === null) return;
    event.preventDefault(); // also keeps the default menu's own zoom roles out
    settings.set({ zoomFactor: stepZoom(contents.getZoomFactor(), direction) });
    applyZoom(); // also when the step equals the saved value (page zoomed itself)
  });

  // ── Inject custom headers on every request ──────────────────────────────────
  const filter = { urls: ["*://*/*"] };
  const appOrigin = new URL(config.APP_URL).origin;
  mainWindow.webContents.session.webRequest.onBeforeSendHeaders(
    { urls: ["*://*/*"] },
    (details, callback) => {
      const headers = { ...details.requestHeaders };
      // Always inject desktop identification headers
      headers[config.CUSTOM_HEADER_NAME] = config.CUSTOM_HEADER_VALUE;
      headers["User-Agent"] = buildUserAgent(APP_VERSION);

      let redirectURL;
      try {
        const parsedUrl = new URL(details.url);
        const encodedHeaders = parsedUrl.searchParams.get("aniverse-headers");
        if (encodedHeaders) {
          const extraHeaders = JSON.parse(decodeURIComponent(encodedHeaders));
          for (const [key, value] of Object.entries(extraHeaders)) {
            headers[key] = value;
          }
          parsedUrl.searchParams.delete("aniverse-headers");
          redirectURL = parsedUrl.toString();
        }
      } catch (e) {
        console.warn(
          "[headers] Failed to parse aniverse-headers param:",
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
      // The response's own CORS headers may differ in case ("Access-Control-
      // Allow-Origin"): left in, Chromium sees two values and blocks it.
      for (const name of Object.keys(headers)) {
        if (name.toLowerCase().startsWith("access-control-allow-")) {
          delete headers[name];
        }
      }
      headers["access-control-allow-origin"] = [appOrigin];
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

  mainWindow.loadFile(path.join(__dirname, "loading.html"));

  const targetUrl = basePath ? `${config.APP_URL}${basePath}` : config.APP_URL;
  // Without a connection the site's offline pages open (its service worker
  // keeps them, with the downloads): the target itself for a downloads page.
  let startUrl = targetUrl;

  waitForURL(targetUrl).then((state) => {
    if (state === "offline") startUrl = offlineTarget(targetUrl);
    console.log("[main] Sending app-ready to loader");
    mainWindow?.webContents.send("app-ready");
  });

  ipcMain.once("loader-done", () => {
    console.log("[main] Loader done, loading URL:", startUrl);
    // A failed load is handled by did-fail-load below
    mainWindow
      ?.loadURL(startUrl, { extraHeaders: buildExtraHeaders(APP_VERSION) })
      .catch(() => {});
  });

  // The site didn't load for want of a network and its service worker had
  // nothing for it (first start offline): the app's own offline page.
  mainWindow.webContents.on(
    "did-fail-load",
    (_event, errorCode, _description, validatedURL, isMainFrame) => {
      if (!isMainFrame || !NETWORK_ERRORS.has(errorCode)) return;
      if (!String(validatedURL).startsWith(config.APP_URL)) return;
      console.log("[main] Site unreachable, showing the offline page:", errorCode);
      offlineRetryUrl = validatedURL;
      mainWindow?.loadFile(path.join(__dirname, "offline.html")).catch(() => {});
    },
  );

  // A server error page that isn't the site's (no title bar): the app's own
  watchServerErrorPages(mainWindow.webContents, {
    appUrl: config.APP_URL,
    onForeignErrorPage: (url, status) => {
      console.log("[main] Server error page from", url, "status", status);
      offlineRetryUrl = url;
      mainWindow
        ?.loadFile(path.join(__dirname, "offline.html"), { query: { reason: "server" } })
        .catch(() => {});
    },
  });

  // ── Open external links in default browser ───────────────────────────────────
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(config.APP_URL)) {
      shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });

  // ── Register with express server ─────────────────────────────────────────────
  setMainWindow(mainWindow, goToPath);

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

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
      mainWindow.maximize();
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

// Chromium's network errors (net_error_list.h) that mean "no connection to
// the site": the offline page then (did-fail-load).
const NETWORK_ERRORS = new Set([
  -7, // TIMED_OUT
  -21, // NETWORK_CHANGED
  -100, // CONNECTION_CLOSED
  -101, // CONNECTION_RESET
  -102, // CONNECTION_REFUSED
  -104, // CONNECTION_FAILED
  -105, // NAME_NOT_RESOLVED
  -106, // INTERNET_DISCONNECTED
  -109, // ADDRESS_UNREACHABLE
  -118, // CONNECTION_TIMED_OUT
  -137, // NAME_RESOLUTION_FAILED
]);
// Failed fetches in a row before the start goes on offline.
const OFFLINE_AFTER_FAILURES = 3;

// The offline page for the start, unless it was a downloads page (deep link).
function offlineTarget(targetUrl) {
  const pathname = new URL(targetUrl).pathname;
  return pathname === "/downloads" || pathname.startsWith("/downloads/")
    ? targetUrl
    : `${config.APP_URL}/offline`;
}

// The page the app's offline page retries (did-fail-load).
let offlineRetryUrl = null;

// Poll until the Next.js server responds: "online", or "offline" when the
// computer has no network or the site can't be reached a few times in a row
// (a server answering with an error is still waited for).
async function waitForURL(url, intervalMs = 500) {
  console.log("[main] Waiting for URL:", url);
  let failures = 0;
  while (true) {
    if (!net.isOnline()) {
      console.log("[main] No network: starting offline");
      return "offline";
    }
    try {
      const res = await fetch(
        url,
        process.argv.includes("--loc")
          ? {}
          : { signal: AbortSignal.timeout(5000) },
      );
      failures = 0;
      if (res.ok) {
        console.log("[main] URL is ready:", url);
        return "online";
      } else {
        console.log("[main] URL not ready, status:", res.status);
      }
    } catch (e) {
      console.log("[main] Fetch failed:", e.message);
      failures++;
      if (failures >= OFFLINE_AFTER_FAILURES) {
        console.log("[main] Site unreachable: starting offline");
        return "offline";
      }
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// ── Deep link handler ─────────────────────────────────────────────────────────
function handleDeepLink(url) {
  if (!url) return;

  try {
    const parsed = new URL(url);
    const action = parsed.hostname;
    const params = Object.fromEntries(parsed.searchParams.entries());

    // aniverse://minecraft/update?install=… (the in-game update mod)
    if (action === "minecraft") {
      minecraft?.handleDeepLink(parsed);
      return;
    }

    const path = action === "open" ? params.path : null;

    goToPath(path);
  } catch (e) {
    console.error("[deeplink] Failed to parse URL:", e.message);
  }
}

// ── .avm files opened from the file explorer (package.json fileAssociations) ──
// Windows / Linux: the file is an argument (to this run, or to a second one
// that hands it over); macOS: "open-file", possibly before the app is ready.
// It opens on the site's /downloads/read, offline too.
function avmPathFrom(args) {
  return args?.find((arg) => typeof arg === "string" && !arg.startsWith("-") && /\.avm$/i.test(arg)) ?? null;
}

let pendingAvmFile = process.platform !== "darwin" ? avmPathFrom(process.argv.slice(1)) : null;

/** Where an opened .avm file is read; null (and a message) when it isn't one. */
function avmTarget(filePath) {
  const target = openChapterFile(filePath);
  if (!target) {
    console.warn("[main] Not a readable .avm file:", filePath);
    void dialog
      .showMessageBox({
        type: "warning",
        title: "Aniverse",
        message: "Impossible d’ouvrir ce fichier",
        detail: "Ce fichier n’est pas un chapitre Aniverse (.avm), ou il est endommagé.",
      })
      .catch(() => {});
  }
  return target;
}

function openAvmFile(filePath) {
  const target = avmTarget(filePath);
  if (target) goToPath(target);
}

app.on("open-file", (event, filePath) => {
  if (!/\.avm$/i.test(filePath)) return;
  event.preventDefault();
  if (app.isReady()) openAvmFile(filePath); // a new window when none is open
  else pendingAvmFile = filePath;
});

// ── Second instance (Windows/Linux deep link) ─────────────────────────────────
app.on("second-instance", (_event, commandLine) => {
  // An .avm file double-clicked while the app runs: opened in this window
  const avmFile = avmPathFrom(commandLine.slice(1));
  if (avmFile) {
    openAvmFile(avmFile);
    return;
  }
  // The deep link URL is the last argument on Windows/Linux
  const url = commandLine.find((arg) =>
    arg.startsWith(`${config.DEEP_LINK_PROTOCOL}://`),
  );
  if (url) handleDeepLink(url);

  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.maximize();
    mainWindow.focus();
  } else {
    // If mainWindow is null (window was closed), create a new one
    createWindow();
  }
});

// ── macOS deep link ───────────────────────────────────────────────────────────
app.on("open-url", (event, url) => {
  event.preventDefault();
  handleDeepLink(url);
});

// ── Settings: applied by the main process ─────────────────────────────────────

// Events with settings / update data: only the site's own pages get them.
function sendToApp(channel, payload) {
  try {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const origin = new URL(mainWindow.webContents.getURL()).origin;
    if (origin !== APP_ORIGIN) return;
    mainWindow.webContents.send(channel, payload);
  } catch (_) {}
}

// Never registers electron.exe from a dev run. `onlyIfDifferent` (startup):
// left as it is when it already matches, so an entry the user turned off in
// Windows' startup apps (still registered, only disabled) isn't turned back on.
function applyLoginItem(openAtLogin, { onlyIfDifferent = false } = {}) {
  if (!app.isPackaged) return;
  try {
    if (
      onlyIfDifferent &&
      app.getLoginItemSettings({ args: ["--startup"] }).openAtLogin === openAtLogin
    ) {
      return;
    }
    app.setLoginItemSettings({ openAtLogin, args: ["--startup"] });
  } catch (err) {
    console.error("[settings] login item:", err.message);
  }
}

const discordOptions = (s) => ({
  enabled: s.discordRichPresence,
  showTitle: s.discordShowTitle,
  showButton: s.discordShowButton,
});

settings.onChange((next, _previous, changed) => {
  const has = (...keys) => keys.some((key) => changed.includes(key));
  if (has("openAtLogin")) applyLoginItem(next.openAtLogin);
  if (has("autoCheckUpdates", "autoDownloadUpdates", "installUpdatesOnQuit")) {
    applyUpdateSettings(next);
  }
  if (has("discordRichPresence", "discordShowTitle", "discordShowButton")) {
    Promise.resolve(configureDiscordRPC(discordOptions(next))).catch(() => {});
  }
  if (has("maxConcurrentDownloads")) {
    setMaxConcurrentDownloads(next.maxConcurrentDownloads);
  }
  if (has("zoomFactor") && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.setZoomFactor(next.zoomFactor);
  }
  sendToApp("settings:changed", settings.snapshot());
});

// A download notification was clicked: the window, with the downloads popover.
function openDownloadsFromNotification() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    // The site comes after the loading page: the popover opens once the site
    // has loaded and had a moment to start (sendToApp checks the origin).
    const contents = mainWindow.webContents;
    const onLoad = () => {
      if (!contents.getURL().startsWith(config.APP_URL)) return;
      contents.off("did-finish-load", onLoad);
      setTimeout(() => sendToApp("downloads:open"), 1500);
    };
    contents.on("did-finish-load", onLoad);
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  sendToApp("downloads:open");
}

// Restart (hardware acceleration): downloads are interrupted like a quit.
function relaunchApp() {
  interruptDownloads();
  // An update waiting to install on quit installs now and starts the app
  // after (updater.js restartWithUpdate); if its installer doesn't start,
  // the app restarts as usual.
  if (restartWithUpdate()) {
    setTimeout(relaunchNow, 5000).unref?.();
    return;
  }
  relaunchNow();
}

function relaunchNow() {
  // The quit's update install would close the relaunched app (installed next run).
  skipInstallOnQuit();
  const args = process.argv
    .slice(1)
    .filter(
      (arg) =>
        arg !== "--startup" &&
        !arg.startsWith(`${config.DEEP_LINK_PROTOCOL}://`),
    );
  app.relaunch({ args });
  app.exit(0);
}

// ── App lifecycle ─────────────────────────────────────────────────────────────
// Minecraft modpack (minecraft/): set up once the app is ready.
let minecraft = null;

app.whenReady().then(() => {
  startDiscordRPC(discordOptions(settings.get()));
  // A getter: createWindow() can run again (second instance, activate, …).
  initDownload(() => mainWindow, store, {
    userAgent: buildUserAgent(APP_VERSION),
    appOrigin: new URL(config.APP_URL).origin,
    maxConcurrent: settings.get().maxConcurrentDownloads,
    notificationsEnabled: () => settings.get().downloadNotifications,
    onNotificationClick: openDownloadsFromNotification,
  });
  // Once, sending to the current window (createWindow() can run again).
  setupAutoUpdater({
    getWindow: () => mainWindow,
    sendToApp,
    isPackaged: app.isPackaged,
    currentVersion: APP_VERSION,
    settings: settings.get(),
  });
  minecraft = initMinecraft({ store, sendToApp });
  // Launched by a double-click on an .avm file: the window opens on it
  const startFile = pendingAvmFile;
  pendingAvmFile = null;
  createWindow((startFile && avmTarget(startFile)) || null);

  // If the app was launched via deep link (Windows/Linux), handle it now.
  if (initialDeepLink) {
    handleDeepLink(initialDeepLink);
    initialDeepLink = null;
  }

  // ── Login item from the settings (off by default) ──────────────────────────
  applyLoginItem(settings.get().openAtLogin, { onlyIfDifferent: true });

  app.on("activate", () => {
    // macOS: re-open window when dock icon is clicked
    if (BrowserWindow.getAllWindows().length === 0 || !mainWindow) {
      createWindow();
    } else if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });

});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  interruptDownloads();
  minecraft?.stop();
  stopUpdateTimer();
  if (expressServer) {
    expressServer.close(() => console.log("[express] Server closed"));
  }
});

let wasMaximizedBeforePiP = false;
// ── IPC handlers ──────────────────────────────────────────────────────────────
ipcMain.handle("get-app-version", () => APP_VERSION);
ipcMain.handle("get-platform", () => process.platform);
ipcMain.handle("open-external", (_, url) => shell.openExternal(url));
ipcMain.handle("open-devtools", () => mainWindow?.webContents?.openDevTools());
ipcMain.handle("install-update", () => installUpdate());
ipcMain.handle("is-always-on-top", () => {
  return mainWindow.isAlwaysOnTop();
});
ipcMain.handle("toggle-always-on-top", () => {
  const newState = !mainWindow.isAlwaysOnTop();
  mainWindow.setAlwaysOnTop(newState);
  return newState;
});
ipcMain.handle("show-window", () => {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  }
});
ipcMain.handle("minimize", () => mainWindow?.minimize());
ipcMain.handle("maximize", () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow.maximize();
  }
});
ipcMain.handle("unmaximize", () => mainWindow?.unmaximize());
ipcMain.handle("close", () => {
  mainWindow?.close();
  isPiP = false;
});
ipcMain.handle("reload", () => mainWindow?.webContents?.reload());
ipcMain.handle("force-reload", () =>
  mainWindow?.webContents?.reloadIgnoringCache(),
);
// Gated by the settings in rpc.js (the express route goes through it too).
ipcMain.handle("update-discord-rpc", (_, data) => updateDiscordRPC(data));
ipcMain.handle("clear-discord-rpc", () => clearDiscordRPC());

// ── Downloads, settings, updates: only the site's own pages may use them ──────
const APP_ORIGIN = new URL(config.APP_URL).origin;

function isFromApp(event) {
  try {
    return new URL(event.senderFrame?.url).origin === APP_ORIGIN;
  } catch (_) {
    return false;
  }
}

function handleFromApp(channel, handler, refused = false) {
  ipcMain.handle(channel, (event, ...args) =>
    isFromApp(event) ? handler(...args) : refused,
  );
}

// Resolves at once (queued); progress arrives through download:update.
handleFromApp("download:start", (request) => startDownload(request), {
  ok: false,
  error: "forbidden",
});
// Quality dialog: the variants with their estimated sizes (~12 s at most).
handleFromApp("download:qualities", (input) => probeDownloadQualities(input), {
  ok: false,
  error: "forbidden",
});
handleFromApp("download:history", () => getDownloads());
// /downloads/watch: the record's aniverse-media: links, null when it can't play
handleFromApp("download:playback", (id) => getDownloadPlayback(id), null);
// A manga chapter's .avm file, built by the site: saved in the download folder
handleFromApp("download:save-chapter", (request) => saveChapter(request), {
  ok: false,
  error: "forbidden",
});
handleFromApp("download:pause", (id) => pauseDownload(id));
handleFromApp("download:resume", (id) => resumeDownload(id));
handleFromApp("download:cancel", (id) => cancelDownload(id));
handleFromApp("download:delete", (id, opts) => deleteDownload(id, opts));
handleFromApp("download:open-file", (id) => openDownloadFile(id));
handleFromApp("download:show-in-folder", (id) => showDownloadInFolder(id));
handleFromApp("download:get-folder", () => getDownloadFolder());
handleFromApp("download:choose-folder", () => chooseDownloadFolder());
handleFromApp("download:open-folder", () => openDownloadFolder());

// Settings: validated by settings.js (unknown keys / values ignored).
handleFromApp("settings:get", () => settings.snapshot(), null);
handleFromApp("settings:set", (patch) => settings.set(patch), null);
handleFromApp("settings:relaunch", () => relaunchApp());
// HTTP cache only (never cookies / storage)
handleFromApp(
  "settings:get-cache-size",
  () => session.defaultSession.getCacheSize().catch(() => null),
  null,
);
handleFromApp(
  "settings:clear-cache",
  () => session.defaultSession.clearCache().then(() => true, () => false),
);

// Updates: "unsupported" in dev builds (status machine in updater.js).
handleFromApp("updates:get-status", () => getUpdateStatus(), null);
handleFromApp("updates:check", () => checkForUpdates(), null);
handleFromApp("updates:download", () => downloadUpdate(), null);
handleFromApp("updates:install", () => installUpdate());

// Minecraft modpack: { ok, data } | { ok: false, error } (codes in minecraft/errors.js).
const MINECRAFT_REFUSED = { ok: false, error: "forbidden" };
const minecraftCall = (fn) => (...args) =>
  minecraft ? fn(...args) : { ok: false, error: "not-ready" };
handleFromApp("minecraft:detect", minecraftCall(() => minecraft.detect()), MINECRAFT_REFUSED);
handleFromApp("minecraft:installs", minecraftCall(() => minecraft.installs()), MINECRAFT_REFUSED);
handleFromApp("minecraft:check", minecraftCall(() => minecraft.check()), MINECRAFT_REFUSED);
handleFromApp("minecraft:install", minecraftCall((target) => minecraft.install(target)), MINECRAFT_REFUSED);
handleFromApp(
  "minecraft:update",
  minecraftCall((installId, opts) => minecraft.update(installId, opts)),
  MINECRAFT_REFUSED,
);
handleFromApp("minecraft:launch", minecraftCall((installId) => minecraft.launch(installId)), MINECRAFT_REFUSED);
handleFromApp("minecraft:cancel", () => minecraft?.cancel() ?? false, false);
handleFromApp("minecraft:status", () => minecraft?.status() ?? null, null);

// ── The app's offline page (offline.html): only from that page ────────────────
function isFromOfflinePage(event) {
  try {
    const url = new URL(event.senderFrame?.url);
    return url.protocol === "file:" && url.pathname.endsWith("/offline.html");
  } catch (_) {
    return false;
  }
}

ipcMain.on("offline:retry", (event) => {
  if (!isFromOfflinePage(event) || !mainWindow || mainWindow.isDestroyed()) return;
  const retry =
    typeof offlineRetryUrl === "string" && offlineRetryUrl.startsWith(config.APP_URL)
      ? offlineRetryUrl
      : config.APP_URL;
  mainWindow
    .loadURL(retry, { extraHeaders: buildExtraHeaders(APP_VERSION) })
    .catch(() => {}); // did-fail-load shows this page again
});
ipcMain.handle("offline:open-download-folder", (event) =>
  isFromOfflinePage(event) ? openDownloadFolder() : false,
);

ipcMain.handle("isPiP", () => isPiP);
ipcMain.handle("update-pip-aspect-ratio", (_, aspectRatio) => {
  storedAspectRatio = aspectRatio;
  if (mainWindow && isPiP) {
    mainWindow.setAspectRatio(aspectRatio);
  }
});
ipcMain.handle("toggle-pip", (_, aspectRatio) => {
  if (!mainWindow) return;

  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  if (!isPiP) {
    previousBounds = mainWindow.getBounds();

    const defaultWidth = 360;
    const defaultHeight = 200;

    const bounds = {
      width: defaultWidth,
      height: defaultHeight,
      x: width - defaultWidth - 20,
      y: height - defaultHeight - 20,
    };

    const isMaximized = mainWindow.isMaximized();
    wasMaximizedBeforePiP = isMaximized;
    if (isMaximized) {
      mainWindow.unmaximize();
    }

    mainWindow.setAlwaysOnTop(true, "floating");
    mainWindow.setResizable(true); // ✅ allow resize
    mainWindow.setMinimumSize(300, 170); // optional safety
    if (aspectRatio) {
      mainWindow.setAspectRatio(aspectRatio);
    }

    mainWindow.setBounds(bounds, true); // animate

    isPiP = true;
  } else {
    if (previousBounds) {
      mainWindow.setBounds(previousBounds);
    }

    isPiP = false;

    mainWindow.setAlwaysOnTop(false);
    mainWindow.setResizable(true);
    mainWindow.setAspectRatio(0);

    if (wasMaximizedBeforePiP) {
      mainWindow.maximize();
      wasMaximizedBeforePiP = false;
    }
  }

  return isPiP;
});
