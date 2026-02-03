const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("updater", {
  onReady: (callback) =>
    ipcRenderer.on("update-ready", (_event, data) => callback(data)),
  onDownloadProgress: (callback) =>
    ipcRenderer.on("update-download-progress", (_event, data) =>
      callback(data)
    ),
  install: () => ipcRenderer.invoke("install-update"),
});

contextBridge.exposeInMainWorld("deepLink", {
  onReceived: (callback) =>
    ipcRenderer.on("deep-link", (_event, data) => callback(data)),
});

contextBridge.exposeInMainWorld("env", {
  isDesktop: true,
  isMac: process.platform === "darwin",
});

contextBridge.exposeInMainWorld("app", {
  onWindowClose: (callback) =>
    ipcRenderer.on("window-close", (_event, data) => callback(data)),
  getAppVersion: () => ipcRenderer.invoke("get-app-version"),
});
