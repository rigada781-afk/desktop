// App settings: defaults, validation of every key, a damaged store, the
// snapshot, listeners, zoom steps and the zoom shortcuts.
const { describe, test, expect } = require("bun:test");
const {
  STORE_KEY,
  DEFAULT_SETTINGS,
  ZOOM_STEPS,
  sanitizePatch,
  normalizeSettings,
  stepZoom,
  zoomShortcut,
  createSettings,
} = require("../settings");

function memoryStore(initial = {}) {
  const data = { ...initial };
  const writes = [];
  return {
    data,
    writes,
    get: (key) => data[key],
    set: (key, value) => {
      data[key] = JSON.parse(JSON.stringify(value));
      writes.push(key);
    },
  };
}

const info = () => ({ version: "0.2.95", platform: "win32", isPackaged: false });

describe("defaults and validation", () => {
  test("the contract's defaults", () => {
    expect(DEFAULT_SETTINGS).toEqual({
      openAtLogin: false,
      startMinimized: false,
      autoCheckUpdates: true,
      autoDownloadUpdates: true,
      installUpdatesOnQuit: true,
      discordRichPresence: true,
      discordShowTitle: true,
      discordShowButton: true,
      downloadQuality: "ask",
      maxConcurrentDownloads: 2,
      downloadNotifications: true,
      hardwareAcceleration: true,
      zoomFactor: 1,
    });
    expect(Object.isFrozen(DEFAULT_SETTINGS)).toBe(true);
    expect(ZOOM_STEPS).toEqual([0.8, 0.9, 1, 1.1, 1.25, 1.5]);
  });

  test("booleans only take booleans", () => {
    const booleans = Object.keys(DEFAULT_SETTINGS).filter((k) => typeof DEFAULT_SETTINGS[k] === "boolean");
    expect(booleans).toHaveLength(10);
    for (const key of booleans) {
      for (const bad of ["true", 1, 0, null, undefined, {}, []]) expect(sanitizePatch({ [key]: bad })).toEqual({});
      expect(sanitizePatch({ [key]: false })).toEqual({ [key]: false });
      expect(sanitizePatch({ [key]: true })).toEqual({ [key]: true });
    }
  });

  test("download quality, simultaneous downloads, zoom", () => {
    for (const ok of ["ask", "best", 1080, 720, 480]) expect(sanitizePatch({ downloadQuality: ok })).toEqual({ downloadQuality: ok });
    for (const bad of ["1080", "1080p", 360, 2160, "", null, true]) expect(sanitizePatch({ downloadQuality: bad })).toEqual({});
    for (const ok of [1, 2, 3]) expect(sanitizePatch({ maxConcurrentDownloads: ok })).toEqual({ maxConcurrentDownloads: ok });
    for (const bad of [0, 4, 2.5, "2", null]) expect(sanitizePatch({ maxConcurrentDownloads: bad })).toEqual({});
    for (const ok of ZOOM_STEPS) expect(sanitizePatch({ zoomFactor: ok })).toEqual({ zoomFactor: ok });
    expect(sanitizePatch({ zoomFactor: 1.1000000001 })).toEqual({ zoomFactor: 1.1 });
    for (const bad of [1.2, 0.5, 2, "1", NaN, Infinity, null]) expect(sanitizePatch({ zoomFactor: bad })).toEqual({});
  });

  test("unknown keys, prototype tricks and non-objects are ignored", () => {
    expect(sanitizePatch({ downloadFolder: "C:/", openAtLogin: true, __proto__: { zoomFactor: 1.5 } })).toEqual({ openAtLogin: true });
    expect(sanitizePatch(JSON.parse('{"__proto__": {"openAtLogin": true}}'))).toEqual({});
    for (const bad of [null, undefined, "x", 42, [], [true]]) expect(sanitizePatch(bad)).toEqual({});
  });

  test("a damaged store keeps the valid keys and falls back for the rest", () => {
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings("garbage")).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings({ zoomFactor: 7, openAtLogin: true, maxConcurrentDownloads: "3", old: 1 })).toEqual({
      ...DEFAULT_SETTINGS,
      openAtLogin: true,
    });
  });
});

describe("createSettings", () => {
  test("snapshot: settings, version, platform, isPackaged, restartRequired", () => {
    const s = createSettings({ store: memoryStore(), info });
    expect(s.snapshot()).toEqual({
      settings: { ...DEFAULT_SETTINGS },
      version: "0.2.95",
      platform: "win32",
      isPackaged: false,
      restartRequired: false,
    });
  });

  test("set: only valid entries applied, persisted under `settings`, full snapshot back", () => {
    const store = memoryStore();
    const s = createSettings({ store, info });
    const snap = s.set({ openAtLogin: true, zoomFactor: 3, maxConcurrentDownloads: 3, unknown: 1 });
    expect(snap.settings).toEqual({ ...DEFAULT_SETTINGS, openAtLogin: true, maxConcurrentDownloads: 3 });
    expect(store.data[STORE_KEY]).toEqual(snap.settings);
    expect(Object.keys(snap)).toEqual(["settings", "version", "platform", "isPackaged", "restartRequired"]);
    // a reload reads them back
    expect(createSettings({ store, info }).get()).toEqual(snap.settings);
  });

  test("nothing valid or nothing new: no write, no listener call", () => {
    const store = memoryStore();
    const s = createSettings({ store, info });
    const calls = [];
    s.onChange((...args) => calls.push(args));
    s.set({ zoomFactor: 9 });
    s.set({ openAtLogin: false }); // already false
    s.set(null);
    expect(store.writes).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("listeners get (settings, previous, changed keys); unsubscribe works; a throwing one doesn't stop the others", () => {
    const s = createSettings({ store: memoryStore(), info });
    const calls = [];
    s.onChange(() => {
      throw new Error("x");
    });
    const off = s.onChange((next, previous, changed) => calls.push({ next, previous, changed }));
    s.set({ discordShowTitle: false, discordRichPresence: true, zoomFactor: 1.25 });
    expect(calls).toHaveLength(1);
    expect(calls[0].changed).toEqual(["discordShowTitle", "zoomFactor"]);
    expect(calls[0].previous.zoomFactor).toBe(1);
    expect(calls[0].next.zoomFactor).toBe(1.25);
    // listeners get copies
    calls[0].next.zoomFactor = 0.8;
    expect(s.get().zoomFactor).toBe(1.25);
    off();
    s.set({ zoomFactor: 1 });
    expect(calls).toHaveLength(1);
    expect(s.onChange("nope")()).toBeUndefined();
  });

  test("restartRequired: hardware acceleration differs from what this run started with", () => {
    const store = memoryStore({ [STORE_KEY]: { hardwareAcceleration: false } });
    const s = createSettings({ store, info });
    expect(s.startedWith.hardwareAcceleration).toBe(false);
    expect(s.snapshot().restartRequired).toBe(false);
    expect(s.set({ hardwareAcceleration: true }).restartRequired).toBe(true);
    expect(s.set({ hardwareAcceleration: false }).restartRequired).toBe(false);
    // other keys never need a restart
    expect(s.set({ zoomFactor: 1.5, openAtLogin: true }).restartRequired).toBe(false);
  });

  test("a store that throws: defaults, and set still answers", () => {
    const broken = {
      get: () => {
        throw new Error("EACCES");
      },
      set: () => {
        throw new Error("EACCES");
      },
    };
    const s = createSettings({ store: broken, info });
    expect(s.get()).toEqual(DEFAULT_SETTINGS);
    expect(s.set({ zoomFactor: 0.9 }).settings.zoomFactor).toBe(0.9);
  });
});

describe("zoom", () => {
  test("stepZoom moves through the steps, stays at the ends, 0 resets", () => {
    expect(stepZoom(1, 1)).toBe(1.1);
    expect(stepZoom(1.1, 1)).toBe(1.25);
    expect(stepZoom(1.25, 1)).toBe(1.5);
    expect(stepZoom(1.5, 1)).toBe(1.5);
    expect(stepZoom(1, -1)).toBe(0.9);
    expect(stepZoom(0.9, -1)).toBe(0.8);
    expect(stepZoom(0.8, -1)).toBe(0.8);
    expect(stepZoom(1.5, 0)).toBe(1);
    expect(stepZoom(0.8, 0)).toBe(1);
  });

  test("a factor between steps (or float noise) goes to the next step in that direction", () => {
    expect(stepZoom(1.2, 1)).toBe(1.25);
    expect(stepZoom(1.2, -1)).toBe(1.1);
    expect(stepZoom(1.1000000001, 1)).toBe(1.25);
    expect(stepZoom(1.0999999, -1)).toBe(1);
    expect(stepZoom(3, -1)).toBe(1.5);
    expect(stepZoom(0.25, 1)).toBe(0.8);
    expect(stepZoom(NaN, 1)).toBe(1.1);
    expect(stepZoom(undefined, -1)).toBe(0.9);
  });

  test("walking all the way up and down visits every step", () => {
    const up = [];
    let z = 0.8;
    for (let i = 0; i < 6; i++) up.push((z = stepZoom(z, 1)));
    expect(up).toEqual([0.9, 1, 1.1, 1.25, 1.5, 1.5]);
  });

  const key = (extra) => ({ type: "keyDown", control: true, alt: false, meta: false, shift: false, ...extra });

  test("zoomShortcut: Ctrl+= / Ctrl++ / numpad, Ctrl+- , Ctrl+0 and AZERTY's Ctrl+à, Cmd on macOS", () => {
    expect(zoomShortcut(key({ key: "=", code: "Equal" }))).toBe(1);
    expect(zoomShortcut(key({ key: "+", code: "Equal", shift: true }))).toBe(1);
    expect(zoomShortcut(key({ key: "+", code: "NumpadAdd" }))).toBe(1);
    expect(zoomShortcut(key({ key: "-", code: "Minus" }))).toBe(-1);
    expect(zoomShortcut(key({ key: "-", code: "Digit6" }))).toBe(-1); // AZERTY
    expect(zoomShortcut(key({ key: "-", code: "NumpadSubtract" }))).toBe(-1);
    expect(zoomShortcut(key({ key: "0", code: "Digit0" }))).toBe(0);
    expect(zoomShortcut(key({ key: "à", code: "Digit0" }))).toBe(0); // AZERTY
    expect(zoomShortcut(key({ key: "0", code: "Numpad0" }))).toBe(0);
    // NumLock off: numpad 0 is Ins, and Ctrl+Ins copies
    expect(zoomShortcut(key({ key: "Insert", code: "Numpad0" }))).toBeNull();
    expect(zoomShortcut(key({ key: "=", control: false, meta: true }))).toBe(1);
  });

  test("zoomShortcut ignores plain keys, keyUp, AltGr characters and other shortcuts", () => {
    expect(zoomShortcut(key({ key: "=", control: false }))).toBeNull();
    expect(zoomShortcut(key({ key: "=", type: "keyUp" }))).toBeNull();
    expect(zoomShortcut(key({ key: "@", code: "Digit0", alt: true }))).toBeNull(); // AltGr+à on AZERTY
    expect(zoomShortcut(key({ key: "}", code: "Equal", alt: true }))).toBeNull();
    expect(zoomShortcut(key({ key: "r", code: "KeyR" }))).toBeNull();
    expect(zoomShortcut(null)).toBeNull();
  });
});
