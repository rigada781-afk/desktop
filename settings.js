// ─── App settings ───────────────────────────────────────────────────────────
// The desktop settings the site's "Paramètres › Application" page reads and
// writes through the bridge (electron-store key `settings`). Every key and
// value is validated here; the main process applies them. No Electron here:
// the store and the app info are injected.

const STORE_KEY = "settings";

// Interface zoom steps (Ctrl+= / Ctrl+- move through them, Ctrl+0 resets).
const ZOOM_STEPS = Object.freeze([0.8, 0.9, 1, 1.1, 1.25, 1.5]);
const DOWNLOAD_QUALITIES = Object.freeze(["ask", "best", 1080, 720, 480]);
const MAX_CONCURRENT_DOWNLOADS = Object.freeze([1, 2, 3]);

const DEFAULT_SETTINGS = Object.freeze({
  // Démarrage
  openAtLogin: false,
  startMinimized: false,
  // Mises à jour
  autoCheckUpdates: true,
  autoDownloadUpdates: true,
  installUpdatesOnQuit: true,
  // Discord
  discordRichPresence: true,
  discordShowTitle: true,
  discordShowButton: true,
  // Téléchargements
  downloadQuality: "ask",
  maxConcurrentDownloads: 2,
  downloadNotifications: true,
  // Autres
  hardwareAcceleration: true,
  zoomFactor: 1,
});

const isBoolean = (value) => typeof value === "boolean";

// A zoom factor from the steps; 1.1000000001 (float noise) counts as 1.1.
function zoomStep(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return ZOOM_STEPS.find((step) => Math.abs(step - value) < 1e-6);
}

// key → (value) => the normalized value, or undefined when invalid
const NORMALIZERS = {
  openAtLogin: (v) => (isBoolean(v) ? v : undefined),
  startMinimized: (v) => (isBoolean(v) ? v : undefined),
  autoCheckUpdates: (v) => (isBoolean(v) ? v : undefined),
  autoDownloadUpdates: (v) => (isBoolean(v) ? v : undefined),
  installUpdatesOnQuit: (v) => (isBoolean(v) ? v : undefined),
  discordRichPresence: (v) => (isBoolean(v) ? v : undefined),
  discordShowTitle: (v) => (isBoolean(v) ? v : undefined),
  discordShowButton: (v) => (isBoolean(v) ? v : undefined),
  downloadQuality: (v) => (DOWNLOAD_QUALITIES.includes(v) ? v : undefined),
  maxConcurrentDownloads: (v) => (MAX_CONCURRENT_DOWNLOADS.includes(v) ? v : undefined),
  downloadNotifications: (v) => (isBoolean(v) ? v : undefined),
  hardwareAcceleration: (v) => (isBoolean(v) ? v : undefined),
  zoomFactor: zoomStep,
};

const isPlainObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** The valid entries of a patch, normalized; unknown keys / bad values dropped. */
function sanitizePatch(patch) {
  const clean = {};
  if (!isPlainObject(patch)) return clean;
  for (const key of Object.keys(NORMALIZERS)) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
    const value = NORMALIZERS[key](patch[key]);
    if (value !== undefined) clean[key] = value;
  }
  return clean;
}

/** Defaults overlaid with the valid stored entries (a damaged store loses only the bad keys). */
function normalizeSettings(stored) {
  return { ...DEFAULT_SETTINGS, ...sanitizePatch(stored) };
}

/**
 * The next zoom step: direction 1 (Ctrl+=), -1 (Ctrl+-), 0 (Ctrl+0 → 1).
 * A factor between two steps (the page's own setZoom) moves to the nearest
 * step in that direction; the ends stay where they are.
 */
function stepZoom(current, direction) {
  if (direction === 0) return 1;
  const value = typeof current === "number" && Number.isFinite(current) ? current : 1;
  if (direction > 0) {
    return ZOOM_STEPS.find((step) => step > value + 1e-6) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1];
  }
  return [...ZOOM_STEPS].reverse().find((step) => step < value - 1e-6) ?? ZOOM_STEPS[0];
}

/**
 * The zoom shortcut of a before-input-event keyDown: 1 (Ctrl+= / Ctrl++),
 * -1 (Ctrl+-), 0 (Ctrl+0; AZERTY's Ctrl+à is the same key), null otherwise.
 * Cmd on macOS. AltGr (Ctrl+Alt on Windows) types characters: never a shortcut.
 */
function zoomShortcut(input) {
  if (!input || input.type !== "keyDown" || input.alt) return null;
  if (!(input.control || input.meta)) return null;
  if (input.key === "=" || input.key === "+") return 1;
  if (input.key === "-" || input.key === "_") return -1;
  // Numpad 0 only as a digit: with NumLock off it is Ins, and Ctrl+Ins copies.
  if (input.key === "0" || input.code === "Digit0") return 0;
  return null;
}

/**
 * @param {object} options
 * @param {{ get(key: string): any, set(key: string, value: any): void }} options.store
 * @param {() => { version: string, platform: string, isPackaged: boolean }} [options.info]
 */
function createSettings({ store, info = () => ({}) }) {
  let current = normalizeSettings(safeRead());
  // What this run started with: a hardware acceleration change needs a restart.
  const startedWith = { ...current };
  const listeners = new Set();

  function safeRead() {
    try {
      return store.get(STORE_KEY);
    } catch (err) {
      console.error("[settings] store read failed:", err.message);
      return undefined;
    }
  }

  function get() {
    return { ...current };
  }

  function snapshot() {
    const { version = "", platform = process.platform, isPackaged = false } = info() || {};
    return {
      settings: get(),
      version,
      platform,
      isPackaged,
      restartRequired: current.hardwareAcceleration !== startedWith.hardwareAcceleration,
    };
  }

  /** Applies the valid entries of `patch`; listeners get (settings, previous, changedKeys). */
  function set(patch) {
    const clean = sanitizePatch(patch);
    const changed = Object.keys(clean).filter((key) => clean[key] !== current[key]);
    if (!changed.length) return snapshot();
    const previous = current;
    current = { ...current, ...clean };
    try {
      store.set(STORE_KEY, current);
    } catch (err) {
      console.error("[settings] store write failed:", err.message);
    }
    for (const listener of [...listeners]) {
      try {
        listener(get(), { ...previous }, changed);
      } catch (err) {
        console.error("[settings] listener failed:", err?.message || err);
      }
    }
    return snapshot();
  }

  function onChange(listener) {
    if (typeof listener !== "function") return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return { get, set, snapshot, onChange, startedWith: Object.freeze(startedWith) };
}

module.exports = {
  STORE_KEY,
  ZOOM_STEPS,
  DOWNLOAD_QUALITIES,
  MAX_CONCURRENT_DOWNLOADS,
  DEFAULT_SETTINGS,
  sanitizePatch,
  normalizeSettings,
  stepZoom,
  zoomShortcut,
  createSettings,
};
