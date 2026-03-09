// ─── Vumeto Preload Script ────────────────────────────────────────────────────
// Exposes a safe, limited API to the renderer/website via contextBridge.
// The website can use window.vumetoDesktop.* to interact with the desktop app.

const { contextBridge, ipcRenderer } = require("electron");

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
  onUpdateAvailable: (callback) => {
    ipcRenderer.on("update-available", (_event, info) => callback(info));
  },
  onUpdateDownloadProgress: (callback) => {
    ipcRenderer.on("update-download-progress", (_event, progress) =>
      callback(progress)
    );
  },
  onUpdateDownloaded: (callback) => {
    ipcRenderer.on("update-downloaded", (_event, info) => callback(info));
  },
  installUpdate: () => ipcRenderer.invoke("install-update"),

  // ── Deep link events ──────────────────────────────────────────────────────────
  onDeepLink: (callback) => {
    ipcRenderer.on("deep-link", (_event, data) => callback(data));
  },

  minimize: () => ipcRenderer.invoke("minimize"),
  maximize: () => ipcRenderer.invoke("maximize"),
  unmaximize: () => ipcRenderer.invoke("unmaximize"),
  close: () => ipcRenderer.invoke("close"),
  reload: () => ipcRenderer.invoke("reload"),
  forceReload: () => ipcRenderer.invoke("force-reload"),
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
