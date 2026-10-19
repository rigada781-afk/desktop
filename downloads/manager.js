// ─── Download manager ────────────────────────────────────────────────────────
// Queue (2 jobs at a time by default, setMaxConcurrent from the app
// settings), records, throttled events and store writes, startup / quit
// reconciliation. No Electron here: the store, the event
// sender, the folders and the job runner are injected.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { validateRequest } = require("./request");
const {
  buildRecord,
  isActive,
  isSameEpisode,
  reconcileRecords,
  roundProgress,
  sortNewestFirst,
  storable,
} = require("./records");
const { ANIME_FOLDER, buildFileName, partPathFor, pathKey, uniqueOutputPath } = require("./files");
const { runJob: defaultRunJob, createPauseGate } = require("./job");
const { createHttp } = require("./http");
const { abortError, toRecordError } = require("./errors");

const STORE_KEY = "downloads";
const UPDATE_EVENT = "download:update";
const DELETED_EVENT = "download:deleted";

/**
 * @param {object} options
 * @param {{ get(key: string): any, set(key: string, value: any): void }} options.store
 * @param {(channel: string, payload: any) => void} [options.send]
 * @param {string} options.tmpRoot  userData/downloads-tmp
 * @param {() => string} options.getFolder  current download folder
 * @param {() => string | null} [options.ffmpegPath]
 * @param {string} [options.userAgent]  sent when the request has no User-Agent
 * @param {(record: object, request: object) => void} [options.onFinished]  a
 *   job reached a terminal status (completed / error / cancelled /
 *   interrupted); `request` is the validated one (subtitle text included)
 * @param {(id: string) => void} [options.onRemoved]  a record left the list
 * @param {number | null} [options.segmentLimit]  TEST ONLY (scratch runners):
 *   caps every job's segments. Never set by the app, unreachable from IPC.
 */
function createDownloadManager(options) {
  const {
    store,
    send = () => {},
    tmpRoot,
    getFolder,
    ffmpegPath = () => null,
    userAgent = null,
    http = createHttp(),
    runJob = defaultRunJob,
    now = Date.now,
    idFactory = () => crypto.randomUUID(),
    maxConcurrent: initialMaxConcurrent = 2,
    onFinished = () => {},
    onRemoved = () => {},
    emitIntervalMs = 250,
    persistIntervalMs = 5000,
    segmentLimit = null,
  } = options;

  let records = []; // every record, live ones included (persisted as is)
  const jobs = new Map(); // id → job, while queued / downloading / paused
  const queue = []; // ids waiting for a slot
  const reserved = new Set(); // pathKey of the outputs of active jobs
  let running = 0;
  let maxConcurrent = validConcurrency(initialMaxConcurrent) ?? 2;
  let persistTimer = null;
  let lastPersist = 0;

  // ── Store & events ────────────────────────────────────────────────────────

  function persistNow() {
    clearTimeout(persistTimer);
    persistTimer = null;
    lastPersist = now();
    try {
      store.set(STORE_KEY, records.map(storable));
    } catch (err) {
      console.error("[download] store write failed:", err.message);
    }
  }

  // Status changes are written at once, progress at most every 5 s.
  function persist(force) {
    if (force) return persistNow();
    if (persistTimer) return;
    const wait = Math.max(0, persistIntervalMs - (now() - lastPersist));
    persistTimer = setTimeout(persistNow, wait);
    persistTimer.unref?.();
  }

  function sendUpdate(job) {
    job.lastEmit = now();
    try {
      send(UPDATE_EVENT, storable(job.record));
    } catch (_) {}
  }

  // Full records, at most every 250 ms per job (always on status changes).
  function emit(job, force) {
    const elapsed = now() - job.lastEmit;
    if (force || elapsed >= emitIntervalMs) {
      clearTimeout(job.emitTimer);
      job.emitTimer = null;
      sendUpdate(job);
      return;
    }
    if (job.emitTimer) return;
    job.emitTimer = setTimeout(() => {
      job.emitTimer = null;
      if (!job.deleted) sendUpdate(job);
    }, emitIntervalMs - elapsed);
    job.emitTimer.unref?.();
  }

  function replaceRecord(record) {
    const index = records.findIndex((r) => r.id === record.id);
    if (index !== -1) records[index] = record;
  }

  function update(job, patch) {
    if (job.deleted || job.finished) return;
    const previous = job.record;
    const next = { ...previous, ...patch };
    if ("progress" in patch) next.progress = roundProgress(patch.progress);
    for (const key of Object.keys(next)) {
      if (next[key] === undefined) delete next[key];
    }
    job.record = next;
    replaceRecord(next);
    const statusChanged = next.status !== previous.status;
    emit(job, statusChanged);
    persist(statusChanged);
  }

  // Terminal state: the job leaves the registry, its output name is free.
  function finish(job, patch) {
    if (job.finished) return;
    update(job, { ...patch, speedBps: undefined });
    job.finished = true;
    clearTimeout(job.emitTimer);
    job.emitTimer = null;
    jobs.delete(job.id);
    reserved.delete(job.reservedKey);
    const queued = queue.indexOf(job.id);
    if (queued !== -1) queue.splice(queued, 1);
    try {
      onFinished(storable(job.record), job.request);
    } catch (err) {
      console.error("[download] onFinished failed:", err?.message || err);
    }
  }

  // ── Output names ──────────────────────────────────────────────────────────

  function isTaken(fullPath) {
    return (
      reserved.has(pathKey(fullPath)) ||
      fs.existsSync(fullPath) ||
      fs.existsSync(partPathFor(fullPath))
    );
  }

  function reserve(job, outputPath) {
    reserved.delete(job.reservedKey);
    job.reservedKey = pathKey(outputPath);
    reserved.add(job.reservedKey);
  }

  // A file appeared at the reserved name during the job: take the next one.
  function claimOutputPath(job) {
    const current = job.record.outputPath;
    reserved.delete(job.reservedKey);
    const claimed = uniqueOutputPath(path.dirname(current), job.record.fileName, (p) =>
      p === current ? true : isTaken(p),
    );
    reserve(job, claimed.outputPath);
    return claimed;
  }

  // ── Jobs ──────────────────────────────────────────────────────────────────

  async function execute(job) {
    update(job, { status: "downloading", phase: "preparing", progress: 0, startedAt: now() });
    try {
      const result = await runJob({
        id: job.id,
        request: job.request,
        outputPath: job.record.outputPath,
        tmpDir: path.join(tmpRoot, job.id),
        signal: job.controller.signal,
        gate: job.gate,
        http,
        ffmpegPath: ffmpegPath(),
        userAgent,
        segmentLimit,
        now,
        report: (patch) => update(job, patch),
        claimOutputPath: () => claimOutputPath(job),
      });
      finish(job, {
        status: "completed",
        phase: null,
        progress: 100,
        fileName: result.fileName,
        outputPath: result.outputPath,
        sizeBytes: result.sizeBytes,
        finishedAt: now(),
      });
    } catch (err) {
      if (job.finished || job.deleted) return; // cancelled / interrupted already recorded
      if (job.controller.signal.aborted) {
        const kind = job.controller.signal.reason?.kind;
        finish(job, {
          status: kind === "interrupt" ? "interrupted" : "cancelled",
          phase: null,
          finishedAt: now(),
          ...(kind === "interrupt" ? { error: { code: "interrupted", message: "" } } : {}),
        });
        return;
      }
      console.error(`[download] ${job.id} failed:`, err?.message || err);
      finish(job, { status: "error", phase: null, error: toRecordError(err), finishedAt: now() });
    }
  }

  function pump() {
    while (running < maxConcurrent && queue.length) {
      const job = jobs.get(queue.shift());
      if (!job || job.finished) continue;
      running++;
      execute(job).finally(() => {
        running--;
        pump();
      });
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────

  function init() {
    const raw = store.get(STORE_KEY);
    const loaded = Array.isArray(raw)
      ? raw.filter((r) => r && typeof r === "object" && typeof r.id === "string")
      : [];
    const { records: reconciled, interrupted } = reconcileRecords(loaded, now());
    records = reconciled;
    // Remuxes cut by a crash or a quit leave their part file in the download
    // folder: on Windows ffmpeg's still-open output can't be removed at quit.
    // No job runs yet, so any part file of a record that isn't completed is a
    // leftover (a completed one's part file became the final file).
    for (const record of records) {
      if (record.status === "completed" || !record.anime) continue;
      if (typeof record.outputPath !== "string") continue;
      try {
        fs.rmSync(partPathFor(record.outputPath), { force: true, maxRetries: 3, retryDelay: 100 });
      } catch (_) {}
    }
    if (interrupted.length) persistNow();
    // No job survives a restart: its temp files are useless.
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch (err) {
      console.warn("[download] could not clear the temp folder:", err.message);
    }
  }

  function start(raw) {
    const parsed = validateRequest(raw);
    if (!parsed.ok) return { ok: false, error: "invalid-request" };
    const request = parsed.request;

    for (const job of jobs.values()) {
      if (!job.finished && isActive(job.record) && isSameEpisode(job.record, request)) {
        return { ok: true, id: job.id, existing: true };
      }
    }

    let folder;
    let output;
    try {
      // Episodes in their own subfolder: <download folder>/anime/
      folder = path.join(path.resolve(getFolder()), ANIME_FOLDER);
      fs.mkdirSync(folder, { recursive: true });
      output = uniqueOutputPath(folder, buildFileName(request), isTaken);
    } catch (err) {
      console.error("[download] download folder unavailable:", err.message);
      return { ok: false, error: "unavailable" };
    }

    const id = idFactory();
    const record = buildRecord({
      id,
      request,
      fileName: output.fileName,
      outputPath: output.outputPath,
      now: now(),
    });
    const job = {
      id,
      request,
      record,
      controller: new AbortController(),
      gate: createPauseGate(),
      reservedKey: null,
      lastEmit: 0,
      emitTimer: null,
      finished: false,
      deleted: false,
    };
    reserve(job, output.outputPath);
    jobs.set(id, job);
    records.unshift(record);
    queue.push(id);
    sendUpdate(job);
    persistNow();
    pump();
    return { ok: true, id, existing: false };
  }

  function history() {
    return sortNewestFirst(records).map((record) => {
      const copy = storable(record);
      if (copy.status === "completed" && typeof copy.outputPath === "string") {
        copy.fileExists = fs.existsSync(copy.outputPath);
      }
      return copy;
    });
  }

  function getRecord(id) {
    const record = records.find((r) => r.id === id);
    return record ? storable(record) : null;
  }

  function pause(id) {
    const job = jobs.get(id);
    if (!job || job.finished || job.record.status !== "downloading") return false;
    if (job.record.phase !== "preparing" && job.record.phase !== "segments") return false;
    job.gate.pause();
    update(job, { status: "paused", speedBps: 0 });
    return true;
  }

  function resume(id) {
    const job = jobs.get(id);
    if (!job || job.finished || job.record.status !== "paused") return false;
    job.gate.resume();
    update(job, { status: "downloading" });
    return true;
  }

  function cancel(id) {
    const job = jobs.get(id);
    if (!job || job.finished) return false;
    job.controller.abort(abortError("cancel")); // kills ffmpeg, the job cleans its files
    finish(job, { status: "cancelled", phase: null, finishedAt: now() });
    return true;
  }

  function remove(id, opts = {}) {
    const index = records.findIndex((r) => r.id === id);
    const job = jobs.get(id);
    if (index === -1 && !job) return false;
    const record = index === -1 ? null : records[index];
    // Only a completed record's file is ours: an unfinished one's name may
    // have been taken by a later download. The file goes first: still open
    // in a player (Windows refuses), the record stays so the site says the
    // file wasn't deleted and it can be tried again.
    if (opts?.deleteFile === true && !job && record?.status === "completed" && record.outputPath) {
      try {
        if (fs.statSync(record.outputPath).isFile()) fs.unlinkSync(record.outputPath);
      } catch (err) {
        if (err?.code !== "ENOENT") return false;
      }
    }
    if (job) {
      job.deleted = true;
      job.controller.abort(abortError("cancel"));
      clearTimeout(job.emitTimer);
      job.finished = true;
      jobs.delete(id);
      reserved.delete(job.reservedKey);
      const queued = queue.indexOf(id);
      if (queued !== -1) queue.splice(queued, 1);
    }
    if (index !== -1) records.splice(index, 1);
    persistNow();
    try {
      send(DELETED_EVENT, { id });
    } catch (_) {}
    try {
      onRemoved(id);
    } catch (_) {}
    return true;
  }

  /**
   * A download made elsewhere, already complete (a manga chapter's .avm file
   * the site built, chapters.js): its record goes first in the list, and the
   * records it replaces (`replaces`: ids) leave it.
   */
  function addCompleted(record, { replaces = [] } = {}) {
    const gone = records.filter((r) => replaces.includes(r.id) && !jobs.has(r.id));
    records = records.filter((r) => !gone.includes(r));
    records.unshift(record);
    persistNow();
    for (const old of gone) {
      try {
        send(DELETED_EVENT, { id: old.id });
      } catch (_) {}
      try {
        onRemoved(old.id);
      } catch (_) {}
    }
    try {
      send(UPDATE_EVENT, storable(record));
    } catch (_) {}
    return storable(record);
  }

  /** Every record as stored (the history without its fileExists checks). */
  function list() {
    return records.map(storable);
  }

  /**
   * Live from the settings: more slots start queued jobs at once; fewer let
   * the running ones finish, the next ones wait.
   */
  function setMaxConcurrent(n) {
    const value = validConcurrency(n);
    if (value === undefined) return false;
    maxConcurrent = value;
    pump();
    return true;
  }

  /** before-quit: running and queued jobs are aborted and marked interrupted. */
  function interruptAll() {
    const active = [...jobs.values()];
    for (const job of active) {
      job.controller.abort(abortError("interrupt"));
      finish(job, {
        status: "interrupted",
        phase: null,
        error: { code: "interrupted", message: "" },
        finishedAt: now(),
      });
      try {
        fs.rmSync(partPathFor(job.record.outputPath), { force: true });
      } catch (_) {}
    }
    persistNow();
    return active.length;
  }

  return {
    init,
    start,
    history,
    getRecord,
    pause,
    resume,
    cancel,
    delete: remove,
    addCompleted,
    list,
    interruptAll,
    setMaxConcurrent,
    get maxConcurrent() {
      return maxConcurrent;
    },
  };
}

function validConcurrency(n) {
  return Number.isInteger(n) && n >= 1 && n <= 8 ? n : undefined;
}

module.exports = { createDownloadManager, STORE_KEY, UPDATE_EVENT, DELETED_EVENT };
