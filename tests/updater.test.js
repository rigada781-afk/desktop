// Update status machine against a fake electron-updater: unsupported dev
// builds, checks, auto / manual download, errors, live settings, timers and
// the title bar's legacy events.
const { describe, test, expect } = require("bun:test");
const { EventEmitter } = require("events");
const { createUpdater, shortError, STATUS_EVENT } = require("../updater");

function fakeAutoUpdater() {
  const u = new EventEmitter();
  u.calls = [];
  u.autoDownload = true;
  u.autoInstallOnAppQuit = true;
  u.nextCheck = null; // (u) => Promise, drives the events of a check
  u.checkForUpdates = () => {
    u.calls.push("check");
    return u.nextCheck ? u.nextCheck(u) : Promise.resolve(null);
  };
  u.downloadUpdate = () => {
    u.calls.push("download");
    return u.nextDownload ? u.nextDownload(u) : Promise.resolve([]);
  };
  u.quitAndInstall = () => u.calls.push("quitAndInstall");
  return u;
}

function fakeTimers() {
  const pending = [];
  let id = 0;
  return {
    pending,
    setTimeout: (fn, ms) => {
      const t = { id: ++id, fn, ms, kind: "timeout" };
      pending.push(t);
      return t;
    },
    clearTimeout: (t) => {
      const i = pending.indexOf(t);
      if (i !== -1) pending.splice(i, 1);
    },
    setInterval: (fn, ms) => {
      const t = { id: ++id, fn, ms, kind: "interval" };
      pending.push(t);
      return t;
    },
    clearInterval: (t) => {
      const i = pending.indexOf(t);
      if (i !== -1) pending.splice(i, 1);
    },
    // runs the timeout(s) / one tick of the interval(s) of that kind
    fire(kind) {
      for (const t of [...pending].filter((x) => x.kind === kind)) {
        if (kind === "timeout") this.clearTimeout(t);
        t.fn();
      }
    },
  };
}

const quiet = { log() {}, error() {}, warn() {}, info() {} };
const tick = () => new Promise((r) => setTimeout(r, 0));

function setup(extra = {}) {
  const autoUpdater = fakeAutoUpdater();
  const timers = fakeTimers();
  const sent = [];
  const legacy = [];
  let clock = 1000;
  const updater = createUpdater({
    supported: true,
    loadAutoUpdater: () => autoUpdater,
    currentVersion: "0.2.95",
    send: (channel, payload) => legacy.push([channel, payload]),
    sendToApp: (channel, payload) => sent.push([channel, payload]),
    now: () => clock,
    timers,
    firstCheckDelayMs: 10_000,
    checkIntervalMs: 4 * 3600_000,
    logger: quiet,
    ...extra,
  });
  return { updater, autoUpdater, timers, sent, legacy, advance: (ms) => (clock += ms) };
}

const available = (version = "0.3.0") => (u) => {
  u.emit("checking-for-update");
  u.emit("update-available", { version });
  return Promise.resolve({ updateInfo: { version } });
};
const upToDate = (u) => {
  u.emit("checking-for-update");
  u.emit("update-not-available", { version: "0.2.95" });
  return Promise.resolve({});
};

describe("unsupported", () => {
  test("dev builds: unsupported, electron-updater never loaded nor called", async () => {
    let loaded = false;
    const sent = [];
    const updater = createUpdater({
      supported: false,
      loadAutoUpdater: () => {
        loaded = true;
        return fakeAutoUpdater();
      },
      currentVersion: "0.2.95",
      sendToApp: (c, p) => sent.push([c, p]),
      logger: quiet,
    });
    updater.start();
    updater.applySettings({ autoCheckUpdates: true });
    expect(updater.getStatus()).toEqual({ state: "unsupported", currentVersion: "0.2.95" });
    expect(await updater.check()).toEqual({ state: "unsupported", currentVersion: "0.2.95" });
    expect(updater.download()).toEqual({ state: "unsupported", currentVersion: "0.2.95" });
    updater.install();
    expect(loaded).toBe(false);
    expect(sent).toEqual([]);
  });

  test("electron-updater failing to load: unsupported", () => {
    const sent = [];
    const updater = createUpdater({
      supported: true,
      loadAutoUpdater: () => {
        throw new Error("no app-update.yml");
      },
      currentVersion: "0.2.95",
      sendToApp: (c, p) => sent.push([c, p]),
      logger: quiet,
    });
    updater.start();
    expect(updater.getStatus().state).toBe("unsupported");
    expect(sent[0][0]).toBe(STATUS_EVENT);
  });
});

describe("status machine", () => {
  test("idle → checking → not-available, with lastCheckedAt and a status event each time", async () => {
    const { updater, autoUpdater, sent } = setup();
    updater.start();
    expect(updater.getStatus()).toEqual({ state: "idle", currentVersion: "0.2.95" });
    autoUpdater.nextCheck = upToDate;
    const result = await updater.check();
    expect(result).toEqual({ state: "not-available", currentVersion: "0.2.95", lastCheckedAt: 1000 });
    expect(sent.map(([c, p]) => [c, p.state])).toEqual([
      [STATUS_EVENT, "checking"],
      [STATUS_EVENT, "not-available"],
    ]);
  });

  test("auto download: available → downloading (progress) → downloaded; legacy title bar events kept", async () => {
    const { updater, autoUpdater, sent, legacy } = setup();
    updater.start();
    autoUpdater.nextCheck = available("0.3.0");
    const result = await updater.check();
    expect(result).toMatchObject({ state: "downloading", version: "0.3.0", progress: { percent: 0 } });
    autoUpdater.emit("download-progress", { percent: 41.6, bytesPerSecond: 2e6, transferred: 4e7, total: 9.6e7 });
    expect(updater.getStatus()).toEqual({
      state: "downloading",
      currentVersion: "0.2.95",
      version: "0.3.0",
      lastCheckedAt: 1000,
      progress: { percent: 42, bytesPerSecond: 2e6, transferred: 4e7, total: 9.6e7 },
    });
    autoUpdater.emit("update-downloaded", { version: "0.3.0" });
    expect(updater.getStatus()).toEqual({ state: "downloaded", currentVersion: "0.2.95", version: "0.3.0", lastCheckedAt: 1000 });
    expect(legacy).toEqual([
      ["update-available", { version: "0.3.0" }],
      ["update-download-progress", { percent: 42, bytesPerSecond: 2e6, transferred: 4e7, total: 9.6e7 }],
      ["update-downloaded", { version: "0.3.0" }],
    ]);
    expect(sent.at(-1)[1].state).toBe("downloaded");
    // getStatus returns copies
    updater.getStatus().version = "x";
    expect(updater.getStatus().version).toBe("0.3.0");
  });

  test("no check while one runs or once an update is ready", async () => {
    const { updater, autoUpdater } = setup();
    updater.start();
    autoUpdater.nextCheck = available();
    await updater.check();
    expect((await updater.check()).state).toBe("downloading");
    autoUpdater.emit("update-downloaded", { version: "0.3.0" });
    expect((await updater.check()).state).toBe("downloaded");
    expect(autoUpdater.calls.filter((c) => c === "check")).toHaveLength(1);
  });

  test("manual download when auto download is off", async () => {
    const { updater, autoUpdater } = setup({ settings: { autoDownloadUpdates: false } });
    updater.start();
    expect(autoUpdater.autoDownload).toBe(false);
    autoUpdater.nextCheck = available("0.3.1");
    expect(await updater.check()).toEqual({ state: "available", currentVersion: "0.2.95", version: "0.3.1", lastCheckedAt: 1000 });
    const started = updater.download();
    expect(started).toMatchObject({ state: "downloading", version: "0.3.1", progress: { percent: 0 } });
    await tick();
    expect(autoUpdater.calls).toEqual(["check", "download"]);
    // download() outside "available" does nothing
    expect(updater.download().state).toBe("downloading");
    await tick();
    expect(autoUpdater.calls).toEqual(["check", "download"]);
  });

  test("a failed download → error (short, no secrets), then a new check works", async () => {
    const { updater, autoUpdater } = setup({ settings: { autoDownloadUpdates: false } });
    updater.start();
    autoUpdater.nextCheck = available("0.3.1");
    await updater.check();
    autoUpdater.nextDownload = () =>
      Promise.reject(new Error("net::ERR_CONNECTION_RESET https://github.com/a/b/releases/download/x.exe?token=SECRET\nstack"));
    updater.download();
    await tick();
    await tick();
    const status = updater.getStatus();
    expect(status.state).toBe("error");
    expect(status.error).toBe("net::ERR_CONNECTION_RESET https://github.com/a/b/releases/download/x.exe");
    expect(status.version).toBe("0.3.1");
    autoUpdater.nextCheck = upToDate;
    expect((await updater.check()).state).toBe("not-available");
  });

  test("a failed check (error event + rejection) → one error, counted as checked", async () => {
    const { updater, autoUpdater, sent, advance } = setup();
    updater.start();
    advance(500);
    autoUpdater.nextCheck = (u) => {
      u.emit("checking-for-update");
      const err = new Error("getaddrinfo ENOTFOUND github.com");
      u.emit("error", err);
      return Promise.reject(err);
    };
    const status = await updater.check();
    expect(status).toEqual({ state: "error", currentVersion: "0.2.95", error: "getaddrinfo ENOTFOUND github.com", lastCheckedAt: 1500 });
    expect(sent.filter(([, p]) => p.state === "error")).toHaveLength(1);
  });

  test("install: quitAndInstall", () => {
    const { updater, autoUpdater } = setup();
    updater.start();
    updater.install();
    expect(autoUpdater.calls).toEqual(["quitAndInstall"]);
  });
});

describe("settings and timers", () => {
  test("start: the 10 s first check, then every 4 h; start twice does nothing", async () => {
    const { updater, autoUpdater, timers } = setup();
    updater.start();
    updater.start();
    expect(timers.pending.map((t) => [t.kind, t.ms])).toEqual([
      ["timeout", 10_000],
      ["interval", 4 * 3600_000],
    ]);
    autoUpdater.nextCheck = upToDate;
    timers.fire("timeout");
    await tick();
    expect(autoUpdater.calls).toEqual(["check"]);
    timers.fire("interval");
    await tick();
    expect(autoUpdater.calls).toEqual(["check", "check"]);
  });

  test("autoCheckUpdates off: no timers, manual check still works; back on: interval (no 10 s check once checked)", async () => {
    const { updater, autoUpdater, timers } = setup({ settings: { autoCheckUpdates: false } });
    updater.start();
    expect(timers.pending).toEqual([]);
    autoUpdater.nextCheck = upToDate;
    await updater.check();
    expect(autoUpdater.calls).toEqual(["check"]);
    updater.applySettings({ autoCheckUpdates: true, autoDownloadUpdates: true, installUpdatesOnQuit: true });
    expect(timers.pending.map((t) => t.kind)).toEqual(["interval"]);
    updater.applySettings({ autoCheckUpdates: false, autoDownloadUpdates: true, installUpdatesOnQuit: true });
    expect(timers.pending).toEqual([]);
  });

  test("autoDownload / autoInstallOnAppQuit applied live; auto download turned on while one waits starts it", async () => {
    const { updater, autoUpdater } = setup({ settings: { autoDownloadUpdates: false, installUpdatesOnQuit: false } });
    updater.start();
    expect([autoUpdater.autoDownload, autoUpdater.autoInstallOnAppQuit]).toEqual([false, false]);
    autoUpdater.nextCheck = available();
    await updater.check();
    expect(updater.getStatus().state).toBe("available");
    updater.applySettings({ autoCheckUpdates: true, autoDownloadUpdates: true, installUpdatesOnQuit: true });
    expect([autoUpdater.autoDownload, autoUpdater.autoInstallOnAppQuit]).toEqual([true, true]);
    expect(updater.getStatus().state).toBe("downloading");
    await tick();
    expect(autoUpdater.calls).toEqual(["check", "download"]);
  });

  test("stop clears the timers", () => {
    const { updater, timers } = setup();
    updater.start();
    updater.stop();
    expect(timers.pending).toEqual([]);
  });
});

test("shortError: first line, URLs without their query, at most 200 chars", () => {
  expect(shortError(new Error("a\nb"))).toBe("a");
  expect(shortError("x https://h.test/p?q=1#f y")).toBe("x https://h.test/p y");
  expect(shortError(new Error("z".repeat(500)))).toHaveLength(200);
  expect(shortError(undefined)).toBe("Erreur inconnue");
});
