const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("updater", {
  onReady: (callback) => ipcRenderer.on("update-ready", callback),
  onDownloadProgress: (callback) =>
    ipcRenderer.on("update-download-progress", callback),
  install: () => ipcRenderer.invoke("install-update"),
});

contextBridge.exposeInMainWorld("deepLink", {
  onReceived: (callback) => ipcRenderer.on("deep-link", callback),
});

contextBridge.exposeInMainWorld("env", {
  isDesktop: true,
  isMac: process.platform === "darwin",
});

contextBridge.exposeInMainWorld("app", {
  onWindowClose: (callback) => ipcRenderer.on("window-close", callback),
  getAppVersion: () => ipcRenderer.invoke("get-app-version"),
});
