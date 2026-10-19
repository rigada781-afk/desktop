// ─── Episode downloads (Electron side) ───────────────────────────────────────
// Wires the download manager to the app: userData temp folder, the download
// folder (electron-store `downloadFolder`, default <Downloads>/Aniverse),
// the bundled ffmpeg, events to the current window, shell / dialog actions
// looked up by record id (never a path from the page), the quality probe,
// native notifications when a job finishes while the window isn't focused,
// and the aniverse-media: scheme the site's /downloads/watch plays from
// (media.js).

const fs = require("fs");
const path = require("path");
const { app, dialog, net, protocol, shell, Notification } = require("electron");
const { createDownloadManager } = require("./manager");
const { createQualityProbe } = require("./probe");
const { resolveFfmpegPath } = require("./ffmpeg");
const { downloadNotification } = require("./notify");
const { SCHEME: MEDIA_SCHEME, createMediaServer } = require("./media");
const { createChapterSaver } = require("./chapters");
const { pathKey } = require("./files");

const FOLDER_KEY = "downloadFolder";

let manager = null;
let probe = null;
let media = null;
let chapters = null;
let store = null;
let getWindow = () => null;
let appOrigin = null;
let notificationsEnabled = () => false;
let onNotificationClick = () => {};
const shownNotifications = new Set(); // kept referenced until clicked / closed

function defaultFolder() {
  return path.join(app.getPath("downloads"), "Aniverse");
}

function getDownloadFolder() {
  const saved = store?.get(FOLDER_KEY);
  return typeof saved === "string" && path.isAbsolute(saved) ? saved : defaultFolder();
}

function sendToRenderer(channel, payload) {
  try {
    const win = getWindow();
    if (!win || win.isDestroyed()) return;
    // Records name the user's files and folders: only the site's own pages
    // get them (the window can be on a sign-in provider's page).
    if (appOrigin && new URL(win.webContents.getURL()).origin !== appOrigin) return;
    win.webContents.send(channel, payload);
  } catch (_) {}
}

function isWindowFocused() {
  try {
    const win = getWindow();
    return !!win && !win.isDestroyed() && win.isFocused();
  } catch (_) {
    return false;
  }
}

// Completed / failed while the window isn't focused: a native notification;
// its click brings the window back with the site's downloads popover.
function notifyFinished(record) {
  const content = downloadNotification(record, {
    enabled: notificationsEnabled(),
    focused: isWindowFocused(),
  });
  if (!content) return;
  try {
    if (!Notification.isSupported()) return;
    const notification = new Notification({
      title: content.title,
      body: content.body,
      icon: path.join(__dirname, "..", "assets", "icons", "filled", "icon.png"),
    });
    shownNotifications.add(notification);
    const release = () => shownNotifications.delete(notification);
    notification.on("click", () => {
      release();
      try {
        onNotificationClick(record);
      } catch (_) {}
    });
    notification.on("close", release);
    notification.on("failed", release);
    notification.show();
  } catch (err) {
    console.warn("[download] notification failed:", err?.message || err);
  }
}

/**
 * Before the app is ready (main.js, at startup): the scheme streams video
 * (byte ranges), and pages may fetch it (subtitles) with CORS.
 */
function registerMediaScheme() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MEDIA_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
    },
  ]);
}

// A job reached its end: the notification, and for a completed one the
// subtitles' original text and the posters, kept for the offline pages.
function onJobFinished(record, request) {
  if (record?.status === "completed" && media) {
    media.saveSidecars(record, request);
    void media.warmImages([record]).catch(() => {});
  }
  notifyFinished(record);
}

/**
 * @param {() => Electron.BrowserWindow | null} windowGetter  read on every
 *   event, so a re-created window keeps receiving them
 * @param {import("electron-store")} newStore
 * @param {{ userAgent?: string, appOrigin?: string, maxConcurrent?: number,
 *   notificationsEnabled?: () => boolean, onNotificationClick?: (record) => void }} [options]
 *   appOrigin: the site's origin, the only one events are sent to
 */
function initDownload(windowGetter, newStore, options = {}) {
  getWindow = typeof windowGetter === "function" ? windowGetter : () => windowGetter;
  appOrigin = options.appOrigin || null;
  if (typeof options.notificationsEnabled === "function") notificationsEnabled = options.notificationsEnabled;
  if (typeof options.onNotificationClick === "function") onNotificationClick = options.onNotificationClick;
  if (manager) return;
  store = newStore;
  manager = createDownloadManager({
    store,
    send: sendToRenderer,
    tmpRoot: path.join(app.getPath("userData"), "downloads-tmp"),
    getFolder: getDownloadFolder,
    ffmpegPath: () =>
      resolveFfmpegPath({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath }),
    userAgent: options.userAgent || null,
    maxConcurrent: options.maxConcurrent,
    onFinished: onJobFinished,
    onRemoved: (id) => media?.forget(id),
  });
  probe = createQualityProbe({ userAgent: options.userAgent || null });
  manager.init();

  // Local playback: only the record's own files, by id (media.js)
  media = createMediaServer({
    getRecord: (id) => manager?.getRecord(id) ?? null,
    root: path.join(app.getPath("userData"), "downloads-media"),
    ffmpegPath: () =>
      resolveFfmpegPath({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath }),
    fetchImpl: (url, init) => net.fetch(url, init),
    appOrigin,
    userAgent: options.userAgent || null,
  });
  chapters = createChapterSaver({ manager, getFolder: getDownloadFolder });
  try {
    protocol.handle(MEDIA_SCHEME, (request) => media.handle(request));
  } catch (err) {
    console.error("[download] could not register the media scheme:", err.message);
  }
  // Downloads finished before the posters were kept: fetched once, quietly.
  const warm = setTimeout(() => {
    if (!net.isOnline()) return;
    void media.warmImages(manager.history()).catch(() => {});
  }, 15_000);
  warm.unref?.();
}

/**
 * A manga chapter's .avm file from the site, saved in the download folder
 * (chapters.js); its cover is fetched for the lists right after.
 */
async function saveChapter(request) {
  if (!chapters) return { ok: false, error: "unavailable" };
  const result = await chapters.save(request);
  if (result.ok && media) {
    const record = manager.getRecord(result.id);
    if (record) void media.warmImages([record]).catch(() => {});
  }
  return result;
}

/**
 * An .avm file opened from the file explorer: where the site reads it. One of
 * the app's own downloads opens as such (/downloads/read?id=, its manga's
 * other chapters around it); any other as an opened file (?open=<token>,
 * media.js openFile). Null when it isn't a readable .avm file.
 */
function openChapterFile(filePath) {
  if (!manager || !media || typeof filePath !== "string") return null;
  try {
    const key = pathKey(filePath);
    const record = manager
      .list()
      .find(
        (item) =>
          item.mediaType === "manga" &&
          item.status === "completed" &&
          typeof item.outputPath === "string" &&
          pathKey(item.outputPath) === key,
      );
    if (record && fs.existsSync(record.outputPath)) return `/downloads/read?id=${encodeURIComponent(record.id)}`;
  } catch (_) {}
  const token = media.openFile(filePath);
  return token ? `/downloads/read?open=${encodeURIComponent(token)}` : null;
}

/** What /downloads/watch plays (media.js playback), null when it can't. */
function getDownloadPlayback(id) {
  return media ? media.playback(id) : null;
}

function startDownload(request) {
  if (!manager) return { ok: false, error: "unavailable" };
  return manager.start(request);
}

// The quality dialog's list: one entry per height, duration, estimated sizes.
function probeDownloadQualities(input) {
  if (!probe) return { ok: false, error: "network" };
  return probe.probe(input);
}

function getDownloads() {
  return manager ? manager.history() : [];
}

function pauseDownload(id) {
  return typeof id === "string" && !!manager?.pause(id);
}

function resumeDownload(id) {
  return typeof id === "string" && !!manager?.resume(id);
}

function cancelDownload(id) {
  return typeof id === "string" && !!manager?.cancel(id);
}

function deleteDownload(id, opts) {
  if (typeof id !== "string" || !manager) return false;
  return manager.delete(id, { deleteFile: opts?.deleteFile === true });
}

function completedFile(id) {
  if (typeof id !== "string" || !manager) return null;
  const record = manager.getRecord(id);
  if (record?.status !== "completed" || typeof record.outputPath !== "string") return null;
  return fs.existsSync(record.outputPath) ? record.outputPath : null;
}

async function openDownloadFile(id) {
  const file = completedFile(id);
  if (!file) return false;
  return (await shell.openPath(file)) === "";
}

function showDownloadInFolder(id) {
  const file = completedFile(id);
  if (!file) return false;
  shell.showItemInFolder(file);
  return true;
}

/** Opens the download folder (created when missing) in the file manager. */
async function openDownloadFolder() {
  const folder = getDownloadFolder();
  try {
    fs.mkdirSync(folder, { recursive: true });
  } catch (err) {
    console.warn("[download] could not create the folder:", err.message);
    return false;
  }
  return (await shell.openPath(folder)) === "";
}

/** Live from the settings (1–3). */
function setMaxConcurrentDownloads(n) {
  return !!manager?.setMaxConcurrent(n);
}

async function chooseDownloadFolder() {
  const win = getWindow();
  const dialogOptions = {
    title: "Choisir le dossier des téléchargements",
    defaultPath: getDownloadFolder(),
    properties: ["openDirectory", "createDirectory"],
  };
  const result =
    win && !win.isDestroyed()
      ? await dialog.showOpenDialog(win, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions);
  const picked = result.filePaths?.[0];
  if (result.canceled || !picked) return null;
  const folder = path.resolve(picked);
  store?.set(FOLDER_KEY, folder);
  return folder;
}

/** before-quit: running jobs are aborted and recorded as interrupted. */
function interruptDownloads() {
  return manager ? manager.interruptAll() : 0;
}

module.exports = {
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
};
