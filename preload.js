import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("updater", {
  onReady: (callback) => ipcRenderer.on("update-ready", callback),
  onDownloadProgress: (callback) =>
    ipcRenderer.on("update-download-progress", callback),
  install: () => ipcRenderer.invoke("install-update"),
});

contextBridge.exposeInMainWorld("deepLink", {
  onReceived: (callback) => ipcRenderer.on("deep-link", callback),
});
