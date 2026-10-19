const { describe, test, expect, beforeEach, afterEach } = require("bun:test");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createDownloadManager, STORE_KEY } = require("../downloads/manager");
const { partPathFor } = require("../downloads/files");

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

// A job runner the test drives by hand.
function controllableRunner() {
  const jobs = [];
  const runJob = (ctx) =>
    new Promise((resolve, reject) => {
      const job = { ctx, resolve, reject };
      ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason));
      jobs.push(job);
    });
  return { jobs, runJob };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

function request(n = 1, extra = {}) {
  return {
    source: `https://cdn.test/${n}/master.m3u8`,
    headers: { Authorization: "Bearer secret" },
    anime: { id: "anime-1", title: "Re:Zero" },
    episode: { number: n },
    language: "sub",
    watchPath: `/watch/re-zero?ep=${n}`,
    ...extra,
  };
}

let root;
let folder;
let tmpRoot;
let events;

function manager(extra = {}) {
  const runner = extra.runner || controllableRunner();
  const store = extra.store || memoryStore();
  const m = createDownloadManager({
    store,
    send: (channel, payload) => events.push({ channel, payload }),
    tmpRoot,
    getFolder: () => folder,
    runJob: runner.runJob,
    emitIntervalMs: 250,
    persistIntervalMs: 5000,
    ...extra,
  });
  m.init();
  return { m, runner, store };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "aniverse-mgr-"));
  folder = path.join(root, "Downloads", "Aniverse");
  tmpRoot = path.join(root, "userData", "downloads-tmp");
  events = [];
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("startup", () => {
  test("active records become interrupted, temp folder cleared, part files removed", () => {
    fs.mkdirSync(path.join(tmpRoot, "old-job"), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, "old-job", "00001.ts"), "x");
    fs.mkdirSync(folder, { recursive: true });
    const output = path.join(folder, "A - Épisode 1 (VOSTFR).mp4");
    fs.writeFileSync(partPathFor(output), "partial");
    const store = memoryStore({
      [STORE_KEY]: [
        { id: "d", status: "downloading", phase: "remux", anime: { id: "a" }, outputPath: output, createdAt: 3 },
        { id: "c", status: "completed", anime: { id: "a" }, outputPath: output, createdAt: 2 },
        { id: "legacy", fileName: "x.mp4", masterUrl: "https://x", status: "completed", statusText: "Done", startedAt: 1 },
        "garbage",
      ],
    });
    const { m } = manager({ store });
    const history = m.history();
    expect(history.map((r) => [r.id, r.status])).toEqual([
      ["d", "interrupted"],
      ["c", "completed"],
      ["legacy", "completed"],
    ]);
    expect(history[0].error).toEqual({ code: "interrupted", message: "" });
    expect(store.data[STORE_KEY][0].status).toBe("interrupted");
    expect(fs.existsSync(tmpRoot)).toBe(false);
    expect(fs.existsSync(partPathFor(output))).toBe(false);
    expect(history[1].fileExists).toBe(false);
  });

  test("part files left by a quit or a cancel are removed, whatever the record's state", () => {
    // Windows: ffmpeg's still-open output couldn't be removed when the app quit
    fs.mkdirSync(folder, { recursive: true });
    const left = (name) => {
      const output = path.join(folder, `${name}.mp4`);
      fs.writeFileSync(partPathFor(output), "partial");
      return output;
    };
    const interrupted = left("interrupted");
    const cancelled = left("cancelled");
    const failed = left("error");
    const store = memoryStore({
      [STORE_KEY]: [
        { id: "i", status: "interrupted", anime: { id: "a" }, outputPath: interrupted, createdAt: 3 },
        { id: "c", status: "cancelled", anime: { id: "a" }, outputPath: cancelled, createdAt: 2 },
        { id: "e", status: "error", anime: { id: "a" }, outputPath: failed, createdAt: 1 },
      ],
    });
    const { m } = manager({ store });
    for (const output of [interrupted, cancelled, failed]) expect(fs.existsSync(partPathFor(output))).toBe(false);
    // and the next download of that episode gets its own name back, not " (2)"
    expect(m.start(request(1, { anime: { id: "a", title: "interrupted" }, episode: { number: 1 } })).ok).toBe(true);
    expect(fs.readdirSync(folder)).toEqual(["anime"]);
    expect(fs.readdirSync(path.join(folder, "anime"))).toEqual([]);
  });
});

describe("start", () => {
  test("resolves at once with the queued record, never awaits the job", async () => {
    const { m, runner, store } = manager();
    const result = m.start(request());
    expect(result).toEqual({ ok: true, id: expect.any(String), existing: false });
    expect(events[0].channel).toBe("download:update");
    expect(events[0].payload.status).toBe("queued");
    expect(events[0].payload.fileName).toBe("re-zero-ep-1.mp4");
    expect(events[0].payload.outputPath).toBe(path.join(folder, "anime", "re-zero-ep-1.mp4"));
    expect(fs.existsSync(folder)).toBe(true);
    await tick();
    expect(runner.jobs).toHaveLength(1);
    expect(runner.jobs[0].ctx.tmpDir).toBe(path.join(tmpRoot, result.id));
    expect(runner.jobs[0].ctx.request.headers).toEqual({ Authorization: "Bearer secret" });
    // Nothing secret reaches the store or the renderer.
    expect(JSON.stringify(store.data)).not.toContain("secret");
    expect(JSON.stringify(events)).not.toContain("secret");
    expect(JSON.stringify(store.data)).not.toContain("cdn.test");
  });

  test("invalid requests", () => {
    const { m } = manager();
    expect(m.start({ ...request(), source: "file:///etc/passwd" })).toEqual({ ok: false, error: "invalid-request" });
    expect(m.start(null)).toEqual({ ok: false, error: "invalid-request" });
  });

  test("an unusable folder → unavailable", () => {
    const file = path.join(root, "not-a-folder");
    fs.writeFileSync(file, "x");
    const { m } = manager({ getFolder: () => file });
    expect(m.start(request())).toEqual({ ok: false, error: "unavailable" });
  });

  test("duplicate episode while active → the existing id", () => {
    const { m } = manager();
    const first = m.start(request(1));
    expect(m.start(request(1))).toEqual({ ok: true, id: first.id, existing: true });
    expect(m.start(request(1, { language: "dub" })).existing).toBe(false);
    expect(m.start(request(2)).existing).toBe(false);
  });

  test("names never collide with files or other running jobs", () => {
    fs.mkdirSync(path.join(folder, "anime"), { recursive: true });
    fs.writeFileSync(path.join(folder, "anime", "re-zero-ep-1.mp4"), "old");
    const { m } = manager();
    const a = m.start(request(1));
    const b = m.start(request(1, { anime: { id: "other", title: "Re/Zero" } }));
    const names = m.history().map((r) => r.fileName).sort();
    expect(names).toEqual(["re-zero-ep-1 (2).mp4", "re-zero-ep-1 (3).mp4"]);
    expect(a.id).not.toBe(b.id);
  });
});

describe("queue and lifecycle", () => {
  test("at most 2 jobs run, the next starts when one ends", async () => {
    const { m, runner } = manager();
    const ids = [1, 2, 3].map((n) => m.start(request(n)).id);
    await tick();
    expect(runner.jobs).toHaveLength(2);
    const status = () => Object.fromEntries(m.history().map((r) => [r.id, r.status]));
    expect(status()[ids[2]]).toBe("queued");
    expect(status()[ids[0]]).toBe("downloading");

    runner.jobs[0].resolve({ outputPath: path.join(folder, "x.mp4"), fileName: "x.mp4", sizeBytes: 42 });
    await tick();
    await tick();
    expect(runner.jobs).toHaveLength(3);
    const done = m.history().find((r) => r.id === ids[0]);
    expect(done).toMatchObject({ status: "completed", phase: null, progress: 100, sizeBytes: 42, fileName: "x.mp4" });
    expect(done.finishedAt).toBeGreaterThan(0);
    expect(done.fileExists).toBe(false);
  });

  test("progress events are throttled to one per 250 ms, status changes go at once", async () => {
    const { m, runner } = manager();
    const { id } = m.start(request());
    await tick();
    events.length = 0;
    const { report } = runner.jobs[0].ctx;
    for (let i = 0; i < 50; i++) report({ phase: "segments", progress: i, segmentsDone: i, segmentsTotal: 100 });
    expect(events.length).toBeLessThanOrEqual(1);
    await new Promise((r) => setTimeout(r, 300));
    const last = events[events.length - 1].payload;
    // Full merged records, not patches.
    expect(last).toMatchObject({ id, status: "downloading", phase: "segments", progress: 49, segmentsDone: 49 });
    expect(last.anime.title).toBe("Re:Zero");
    expect(events.length).toBeLessThanOrEqual(2);
    expect(m.pause(id)).toBe(true);
    expect(events[events.length - 1].payload.status).toBe("paused");
  });

  test("store writes: on status changes, progress at most every 5 s", async () => {
    const { m, runner, store } = manager();
    m.start(request());
    await tick();
    const before = store.writes.length;
    for (let i = 0; i < 20; i++) runner.jobs[0].ctx.report({ progress: i });
    expect(store.writes.length).toBe(before);
  });

  test("pause / resume only in the right states", async () => {
    const { m, runner } = manager();
    const a = m.start(request(1)).id;
    m.start(request(2));
    const queued = m.start(request(3)).id;
    await tick();
    expect(m.pause(queued)).toBe(false);
    expect(m.resume(a)).toBe(false);
    expect(m.pause(a)).toBe(true);
    expect(runner.jobs[0].ctx.gate.paused).toBe(true);
    expect(m.pause(a)).toBe(false);
    expect(m.resume(a)).toBe(true);
    expect(runner.jobs[0].ctx.gate.paused).toBe(false);
    runner.jobs[0].ctx.report({ phase: "remux" });
    expect(m.pause(a)).toBe(false);
    expect(m.pause("nope")).toBe(false);
  });

  test("cancel: running job aborted, queued job dropped", async () => {
    const { m, runner } = manager();
    const a = m.start(request(1)).id;
    m.start(request(2));
    const queued = m.start(request(3)).id;
    await tick();
    expect(m.cancel(queued)).toBe(true);
    expect(m.cancel(a)).toBe(true);
    expect(runner.jobs[0].ctx.signal.aborted).toBe(true);
    expect(runner.jobs[0].ctx.signal.reason.kind).toBe("cancel");
    await tick();
    await tick();
    const status = Object.fromEntries(m.history().map((r) => [r.id, r.status]));
    expect(status[a]).toBe("cancelled");
    expect(status[queued]).toBe("cancelled");
    // The cancelled job's slot went to nobody (the queued one was cancelled).
    expect(runner.jobs).toHaveLength(2);
    expect(m.cancel(a)).toBe(false);
  });

  test("errors keep the contract's code", async () => {
    const { m, runner } = manager();
    const { id } = m.start(request());
    await tick();
    const { DownloadError } = require("../downloads/errors");
    runner.jobs[0].reject(new DownloadError("forbidden", "HTTP 403 (cdn.test)"));
    await tick();
    expect(m.history()[0]).toMatchObject({ id, status: "error", error: { code: "forbidden", message: "HTTP 403 (cdn.test)" } });
  });

  test("delete: cancels an active job, deleteFile only for completed records", async () => {
    const { m, runner } = manager();
    fs.mkdirSync(folder, { recursive: true });
    const a = m.start(request(1)).id;
    await tick();
    const out = path.join(folder, "done.mp4");
    fs.writeFileSync(out, "video");
    runner.jobs[0].resolve({ outputPath: out, fileName: "done.mp4", sizeBytes: 5 });
    await tick();
    const b = m.start(request(2)).id;
    await tick();

    expect(m.history().find((r) => r.id === a).fileExists).toBe(true);
    expect(m.delete(b, { deleteFile: true })).toBe(true);
    expect(runner.jobs[1].ctx.signal.aborted).toBe(true);
    expect(events[events.length - 1]).toEqual({ channel: "download:deleted", payload: { id: b } });

    expect(m.delete(a)).toBe(true);
    expect(fs.existsSync(out)).toBe(true);
    expect(m.delete(a)).toBe(false);
    expect(m.history()).toHaveLength(0);

    const c = m.start(request(3)).id;
    await tick();
    runner.jobs[2].resolve({ outputPath: out, fileName: "done.mp4", sizeBytes: 5 });
    await tick();
    expect(m.delete(c, { deleteFile: true })).toBe(true);
    expect(fs.existsSync(out)).toBe(false);
  });

  test("delete with the file: a file the system won't delete keeps its record", async () => {
    const { m, runner } = manager();
    fs.mkdirSync(folder, { recursive: true });
    const id = m.start(request(1)).id;
    await tick();
    const out = path.join(folder, "playing.mp4");
    fs.writeFileSync(out, "video");
    runner.jobs[0].resolve({ outputPath: out, fileName: "playing.mp4", sizeBytes: 5 });
    await tick();
    events = [];
    // Open in a player on Windows
    const unlink = fs.unlinkSync;
    fs.unlinkSync = () => {
      throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
    };
    try {
      expect(m.delete(id, { deleteFile: true })).toBe(false);
    } finally {
      fs.unlinkSync = unlink;
    }
    expect(m.history().map((r) => r.id)).toEqual([id]);
    expect(events.filter((e) => e.channel === "download:deleted")).toEqual([]);
    // Once the player is closed it works; a file already gone is fine too
    expect(m.delete(id, { deleteFile: true })).toBe(true);
    expect(fs.existsSync(out)).toBe(false);
  });

  test("before-quit: running and queued jobs are interrupted and persisted", async () => {
    const { m, runner, store } = manager();
    m.start(request(1));
    m.start(request(2));
    m.start(request(3));
    await tick();
    expect(m.interruptAll()).toBe(3);
    expect(runner.jobs.every((j) => j.ctx.signal.reason.kind === "interrupt")).toBe(true);
    expect(store.data[STORE_KEY].map((r) => r.status)).toEqual(["interrupted", "interrupted", "interrupted"]);
    expect(store.data[STORE_KEY][0].error.code).toBe("interrupted");
    await tick();
    expect(runner.jobs).toHaveLength(2);
  });

  test("segmentLimit is a manager option only (the request cannot set it)", async () => {
    const { m, runner } = manager({ segmentLimit: 12 });
    m.start({ ...request(), segmentLimit: 1 });
    await tick();
    expect(runner.jobs[0].ctx.segmentLimit).toBe(12);
    const plain = manager();
    plain.m.start({ ...request(), segmentLimit: 1 });
    await tick();
    expect(plain.runner.jobs[0].ctx.segmentLimit).toBeNull();
  });
});

describe("settings: simultaneous downloads and finish hook", () => {
  test("setMaxConcurrent: more slots start queued jobs at once, fewer let running ones finish", async () => {
    const { m, runner } = manager({ maxConcurrent: 1 });
    expect(m.maxConcurrent).toBe(1);
    [1, 2, 3, 4].forEach((n) => m.start(request(n)));
    await tick();
    expect(runner.jobs).toHaveLength(1);

    expect(m.setMaxConcurrent(3)).toBe(true);
    await tick();
    expect(runner.jobs).toHaveLength(3);

    // Back to 1: the 3 running keep going, nothing new until only 0 run
    expect(m.setMaxConcurrent(1)).toBe(true);
    runner.jobs[0].resolve({ outputPath: path.join(folder, "a.mp4"), fileName: "a.mp4", sizeBytes: 1 });
    await tick();
    await tick();
    expect(runner.jobs).toHaveLength(3);
    expect(runner.jobs[1].ctx.signal.aborted).toBe(false);
    runner.jobs[1].resolve({ outputPath: path.join(folder, "b.mp4"), fileName: "b.mp4", sizeBytes: 1 });
    runner.jobs[2].resolve({ outputPath: path.join(folder, "c.mp4"), fileName: "c.mp4", sizeBytes: 1 });
    await tick();
    await tick();
    expect(runner.jobs).toHaveLength(4);
  });

  test("setMaxConcurrent ignores bad values; the option defaults to 2", () => {
    const { m } = manager();
    expect(m.maxConcurrent).toBe(2);
    for (const bad of [0, -1, 1.5, "3", null, undefined, NaN, 99]) expect(m.setMaxConcurrent(bad)).toBe(false);
    expect(m.maxConcurrent).toBe(2);
    expect(manager({ maxConcurrent: "x" }).m.maxConcurrent).toBe(2);
  });

  test("onFinished gets the terminal record once (completed, error, cancelled, interrupted), never on delete", async () => {
    const finished = [];
    const { m, runner } = manager({ maxConcurrent: 3, onFinished: (record) => finished.push([record.id, record.status]) });
    const a = m.start(request(1)).id;
    const b = m.start(request(2)).id;
    const c = m.start(request(3)).id;
    await tick();
    runner.jobs[0].resolve({ outputPath: path.join(folder, "a.mp4"), fileName: "a.mp4", sizeBytes: 1 });
    const { DownloadError } = require("../downloads/errors");
    runner.jobs[1].reject(new DownloadError("network", "boom"));
    await tick();
    await tick();
    m.delete(c);
    const d = m.start(request(4)).id;
    const e = m.start(request(5)).id;
    m.cancel(d);
    m.interruptAll();
    await tick();
    expect(finished).toEqual([
      [a, "completed"],
      [b, "error"],
      [d, "cancelled"],
      [e, "interrupted"],
    ]);
  });

  test("a throwing onFinished doesn't break the queue", async () => {
    const { m, runner } = manager({ maxConcurrent: 1, onFinished: () => { throw new Error("x"); } });
    m.start(request(1));
    m.start(request(2));
    await tick();
    runner.jobs[0].resolve({ outputPath: path.join(folder, "a.mp4"), fileName: "a.mp4", sizeBytes: 1 });
    await tick();
    await tick();
    expect(runner.jobs).toHaveLength(2);
    expect(m.history().find((r) => r.status === "completed")).toBeTruthy();
  });
});
