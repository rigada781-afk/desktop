// ─── Vumeto Preload Script ────────────────────────────────────────────────────

const { contextBridge, ipcRenderer, webFrame } = require("electron");

contextBridge.exposeInMainWorld("vumetoDesktop", {
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

  // ── Deep link events ──────────────────────────────────────────────────────────
  onDeepLink: (cb) => {
    ipcRenderer.on("deep-link", (_, data) => cb(data));
  },

  // ── Discord RPC ───────────────────────────────────────────────────────────────
  updateDiscordRPC: (data) => ipcRenderer.invoke("update-discord-rpc", data),
  clearDiscordRPC: () => ipcRenderer.invoke("clear-discord-rpc"),

  // ── Download ───────────────────────────────────────────────────────────────

  download: {
    // Actions
    start: (masterUrl, metadata) =>
      ipcRenderer.invoke("download:start", masterUrl, metadata),
    history: () => ipcRenderer.invoke("download:history"),
    pause: (id) => ipcRenderer.invoke("download:pause", id),
    resume: (id) => ipcRenderer.invoke("download:resume", id),
    cancel: (id) => ipcRenderer.invoke("download:cancel", id),
    delete: (id, opts) => ipcRenderer.invoke("download:delete", id, opts),

    // Events
    onUpdate: (cb) => ipcRenderer.on("download:update", (_, data) => cb(data)),
    onDeleted: (cb) =>
      ipcRenderer.on("download:deleted", (_, data) => cb(data)),

    // Cleanup (call these when your component unmounts)
    offUpdate: (cb) => ipcRenderer.removeListener("download:update", cb),
    offDeleted: (cb) => ipcRenderer.removeListener("download:deleted", cb),
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

interface VumetoDesktop {
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
    vumetoDesktop: VumetoDesktop;
  }
}

*/
