// ─── Aniverse Preload Script ────────────────────────────────────────────────────

const { contextBridge, ipcRenderer, webFrame } = require("electron");

// ── Download event listeners ──────────────────────────────────────────────────
// channel → (page callback → ipc handler), so offUpdate / offDeleted can
// remove what onUpdate / onDeleted added.
const downloadListeners = {
  "download:update": new Map(),
  "download:deleted": new Map(),
};

function unsubscribe(channel, cb) {
  const handlers = downloadListeners[channel];
  const handler = handlers.get(cb);
  if (!handler) return;
  ipcRenderer.removeListener(channel, handler);
  handlers.delete(cb);
}

function subscribe(channel, cb) {
  if (typeof cb !== "function") return () => {};
  const handlers = downloadListeners[channel];
  const handler = (_, data) => cb(data);
  handlers.set(cb, handler);
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
    if (handlers.get(cb) === handler) handlers.delete(cb);
  };
}

// Settings / updates / "open the downloads popover" events: each `on…`
// returns its unsubscribe function.
function listen(channel, cb) {
  if (typeof cb !== "function") return () => {};
  const handler = (_, data) => cb(data);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld("aniverseDesktop", {
  // ── App info ─────────────────────────────────────────────────────────────────
  getVersion: () => ipcRenderer.invoke("get-app-version"),
  getPlatform: () => ipcRenderer.invoke("get-platform"),

  // ── Window control ────────────────────────────────────────────────────────────
  showWindow: () => ipcRenderer.invoke("show-window"),

  // ── Open links in default browser ────────────────────────────────────────────
  openExternal: (url) => ipcRenderer.invoke("open-external", url),

  // ── Open devtools ─────────────────────────────────────────────────────────────
  openDevtools: () => ipcRenderer.invoke("open-devtools"),

  // ── Update events ─────────────────────────────────────────────────────────────
  onUpdateAvailable: (cb) => {
    ipcRenderer.on("update-available", (_, info) => cb(info));
  },
  onUpdateDownloadProgress: (cb) => {
    ipcRenderer.on("update-download-progress", (_, data) => cb(data));
  },
  onUpdateDownloaded: (cb) => {
    ipcRenderer.on("update-downloaded", (_, info) => cb(info));
  },
  installUpdate: () => ipcRenderer.invoke("install-update"),

  // ── App settings (feature-detected by the site: "settings" in aniverseDesktop)
  settings: {
    get: () => ipcRenderer.invoke("settings:get"),
    // Validated by the app (unknown keys / values ignored): the full snapshot
    set: (patch) => ipcRenderer.invoke("settings:set", patch),
    // Also fired when a shortcut changes the zoom
    onChange: (cb) => listen("settings:changed", cb),
    relaunch: () => ipcRenderer.invoke("settings:relaunch"),
    getCacheSize: () => ipcRenderer.invoke("settings:get-cache-size"),
    clearCache: () => ipcRenderer.invoke("settings:clear-cache"),
  },

  // ── Updates (status machine for the settings page) ───────────────────────────
  updates: {
    getStatus: () => ipcRenderer.invoke("updates:get-status"),
    check: () => ipcRenderer.invoke("updates:check"),
    download: () => ipcRenderer.invoke("updates:download"),
    install: () => ipcRenderer.invoke("updates:install"),
    onStatus: (cb) => listen("updates:status", cb),
  },

  // A download notification was clicked: open the site's downloads popover
  onOpenDownloads: (cb) => listen("downloads:open", cb),

  // ── Minecraft modpack (feature-detected by the site: "minecraft" in aniverseDesktop)
  // Calls resolve to { ok: true, data } or { ok: false, error, message }.
  minecraft: {
    // Launchers on this computer: [{ launcher, name, dataDir, installed }]
    detect: () => ipcRenderer.invoke("minecraft:detect"),
    installs: () => ipcRenderer.invoke("minecraft:installs"),
    // Fetches the manifest: { latest, installs } with updateAvailable per install
    check: () => ipcRenderer.invoke("minecraft:check"),
    // { launcher: "official" | "modrinth" | "prism", dataDir? }
    install: (target) => ipcRenderer.invoke("minecraft:install", target),
    // One install, or all when installId is omitted; { verify: true } re-hashes every file
    update: (installId, opts) => ipcRenderer.invoke("minecraft:update", installId, opts),
    // Starts the game (Prism Launcher) or opens the install's launcher on the pack's profile
    launch: (installId) => ipcRenderer.invoke("minecraft:launch", installId),
    cancel: () => ipcRenderer.invoke("minecraft:cancel"),
    status: () => ipcRenderer.invoke("minecraft:status"),
    // Events: each returns its unsubscribe function
    onProgress: (cb) => listen("minecraft:progress", cb),
    onStatus: (cb) => listen("minecraft:status", cb),
    // The in-game mod asked for an update (aniverse://minecraft/update), and its outcome
    onUpdateRequested: (cb) => listen("minecraft:update-requested", cb),
    onUpdateFinished: (cb) => listen("minecraft:update-finished", cb),
  },

  // ── Deep link events ──────────────────────────────────────────────────────────
  onDeepLink: (cb) => {
    ipcRenderer.on("deep-link", (_, data) => cb(data));
  },

  // ── Discord RPC ───────────────────────────────────────────────────────────────
  updateDiscordRPC: (data) => ipcRenderer.invoke("update-discord-rpc", data),
  clearDiscordRPC: () => ipcRenderer.invoke("clear-discord-rpc"),

  // ── Download ───────────────────────────────────────────────────────────────

  download: {
    apiVersion: 2,

    // Actions (start resolves at once: the job is queued)
    start: (request) => ipcRenderer.invoke("download:start", request),
    // Quality dialog (feature-detected by the site): one entry per height
    // with its estimated size
    qualities: (input) => ipcRenderer.invoke("download:qualities", input),
    history: () => ipcRenderer.invoke("download:history"),
    // /downloads/watch (feature-detected by the site): { id, video, subtitles }
    // with aniverse-media: links, or null when the file can't be played
    playback: (id) => ipcRenderer.invoke("download:playback", id),
    // The record's poster, kept on the disk by the app (shown offline too)
    imageUrl: (id, kind = "anime") =>
      `aniverse-media://image/${encodeURIComponent(String(id))}/${kind === "episode" ? "episode" : "anime"}`,
    // Manga chapters (feature-detected by the site): the .avm file the site
    // built, saved in the download folder → { ok, id } | { ok: false, error }
    saveChapter: (request) => ipcRenderer.invoke("download:save-chapter", request),
    // A saved chapter's .avm file, which /downloads/read decrypts
    chapterUrl: (id) => `aniverse-media://chapter/${encodeURIComponent(String(id))}`,
    // An .avm file opened from the file explorer (/downloads/read?open=<token>)
    openedFileUrl: (token) => `aniverse-media://opened/${encodeURIComponent(String(token))}`,
    pause: (id) => ipcRenderer.invoke("download:pause", id),
    resume: (id) => ipcRenderer.invoke("download:resume", id),
    cancel: (id) => ipcRenderer.invoke("download:cancel", id),
    delete: (id, opts) => ipcRenderer.invoke("download:delete", id, opts),
    openFile: (id) => ipcRenderer.invoke("download:open-file", id),
    showInFolder: (id) => ipcRenderer.invoke("download:show-in-folder", id),
    getFolder: () => ipcRenderer.invoke("download:get-folder"),
    chooseFolder: () => ipcRenderer.invoke("download:choose-folder"),
    // Opens the download folder (created when missing)
    openFolder: () => ipcRenderer.invoke("download:open-folder"),

    // Events: each returns its unsubscribe function
    onUpdate: (cb) => subscribe("download:update", cb),
    onDeleted: (cb) => subscribe("download:deleted", cb),
    onOpenDownloads: (cb) => listen("downloads:open", cb),

    // Kept for old site builds. Callbacks crossing the context bridge may
    // not keep their identity, so these can be no-ops: prefer the function
    // onUpdate / onDeleted return.
    offUpdate: (cb) => unsubscribe("download:update", cb),
    offDeleted: (cb) => unsubscribe("download:deleted", cb),
  },

  getZoom: () => webFrame.getZoomFactor(),
  setZoom: (z) => {
    webFrame.setZoomFactor(z);
    return webFrame.getZoomFactor();
  },
  isAlwaysOnTop: () => ipcRenderer.invoke("is-always-on-top"),
  toggleAlwaysOnTop: () => ipcRenderer.invoke("toggle-always-on-top"),
  isPiP: () => ipcRenderer.invoke("isPiP"),
  updatePiPAspectRatio: (aspectRatio) =>
    ipcRenderer.invoke("update-pip-aspect-ratio", aspectRatio),
  togglePiP: (aspectRatio) => ipcRenderer.invoke("toggle-pip", aspectRatio),
  minimize: () => ipcRenderer.invoke("minimize"),
  maximize: () => ipcRenderer.invoke("maximize"),
  unmaximize: () => ipcRenderer.invoke("unmaximize"),
  close: () => ipcRenderer.invoke("close"),
  reload: () => ipcRenderer.invoke("reload"),
  forceReload: () => ipcRenderer.invoke("force-reload"),
});

// Expose API for loading screen
contextBridge.exposeInMainWorld("electronAPI", {
  onAppReady: (callback) => ipcRenderer.on("app-ready", callback),
  sendLoaderDone: () => ipcRenderer.send("loader-done"),
  // The app's offline page (offline.html): try the site again, open the folder
  retryOnline: () => ipcRenderer.send("offline:retry"),
  openDownloadFolder: () => ipcRenderer.invoke("offline:open-download-folder"),
});

/*
TypeScript example:

interface UpdateInfo {
  version: string;
}

interface DownloadProgress {
  percent: number;
  bytesPerSecond: number;
  transferred: number;
  total: number;
}

interface DeepLinkData {
  action: string;
  params: Record<string, string>;
  raw: string;
}

interface AniverseDesktop {
  // App info
  getVersion: () => Promise<string>;
  getPlatform: () => Promise<NodeJS.Platform>;

  // Window control
  showWindow: () => Promise<void>;

  // Open links in default browser
  openExternal: (url: string) => Promise<void>;

  // Open devtools
  openDevtools: () => Promise<void>;

  // Update events
  onUpdateAvailable: (callback: (info: UpdateInfo) => void) => void;
  onUpdateDownloadProgress: (callback: (progress: DownloadProgress) => void) => void;
  onUpdateDownloaded: (callback: (info: UpdateInfo) => void) => void;
  installUpdate: () => Promise<void>;
  // Deep link events
  onDeepLink: (callback: (data: DeepLinkData) => void) => void;

  // Window control
  getZoom: () => Promise<number>;
  setZoom: (zoom: number) => Promise<number>;
  isAlwaysOnTop: () => Promise<boolean>;
  toggleAlwaysOnTop: () => Promise<boolean>;
  isPiP: () => Promise<boolean>;
  updatePiPAspectRatio: (aspectRatio: number) => Promise<void>;
  togglePiP: (aspectRatio: number) => Promise<boolean>;
  minimize: () => void;
  maximize: () => void;
  unmaximize: () => void;
  close: () => void;
  reload: () => void;
  forceReload: () => void;
}

declare global {
  interface Window {
    aniverseDesktop: AniverseDesktop;
  }
}

*/
