// ─── Modpack service ─────────────────────────────────────────────────────────
// Detects launchers, installs the pack into the one the player picks, checks
// for updates and applies them. No Electron here: everything it touches (the
// network, the store, opening a file, child processes, Java) is injected, so
// it runs under `bun test`.
//
// One job at a time (install / update); `check` can run alongside. Records of
// the installs live in the store; the marker file in each game directory is
// the source of truth, so installs are found again even with an empty store.

const { ModpackError, errorCode } = require("./errors");
const { branchManifestUrl, fetchManifest, resolveFileUrl } = require("./manifest");
const { readMarker, writeMarker } = require("./marker");
const { syncPack } = require("./sync");
const { sleep } = require("./download");

const DEFAULTS = {
  instanceName: "Aniverse",
  memoryMB: 6144,
  concurrency: 6,
  installTimeoutMs: 15 * 60_000,
  gamePollMs: 3000,
};

function createModpackService(deps) {
  const opts = { ...DEFAULTS, ...deps.options };
  const launchers = deps.launchers; // { official, modrinth, prism }
  const emitProgress = (p) => deps.onProgress?.(p);
  const emitStatus = () => deps.onStatus?.(status());

  let job = null; // { kind, ac, installId, launcher }
  let latest = null; // { version, minecraft, loader, checkedAt }
  let lastError = null;

  // ── Records ────────────────────────────────────────────────────────────────
  const loadRecords = () => {
    const list = deps.store.get();
    return Array.isArray(list) ? list.filter((r) => r && typeof r.installId === "string" && typeof r.gameDir === "string") : [];
  };
  const saveRecords = (list) => deps.store.set(list);
  const upsert = (record) => {
    const list = loadRecords().filter((r) => r.installId !== record.installId);
    list.push(record);
    saveRecords(list);
    return record;
  };

  function publicRecord(r) {
    const outdated = latest && r.version !== latest.version;
    const gameChanged = latest && r.minecraft && r.minecraft !== latest.minecraft;
    return {
      installId: r.installId,
      launcher: r.launcher,
      launcherName: launchers[r.launcher]?.name || r.launcher,
      dataDir: r.dataDir,
      gameDir: r.gameDir,
      version: r.version || null,
      minecraft: r.minecraft || null,
      loader: r.loader || null,
      installedAt: r.installedAt || null,
      updatedAt: r.updatedAt || null,
      updateAvailable: !!latest && (!r.version || !!outdated),
      // A new Minecraft version, or a loader Modrinth App cannot change from outside: reinstall.
      needsReinstall: !!gameChanged || !!r.needsReinstall,
    };
  }

  /** Records whose marker is still on disk, plus installs found on disk that the store forgot. */
  async function scanInstalls() {
    const byId = new Map(loadRecords().map((r) => [r.installId, r]));
    const live = new Map();
    for (const [id, launcher] of Object.entries(launchers)) {
      for (const { dataDir } of await launcher.detect(deps.sys)) {
        for (const gameDir of await launcher.findInstalls(dataDir)) {
          const marker = await readMarker(gameDir);
          if (!marker) continue;
          const known = byId.get(marker.installId);
          live.set(marker.installId, {
            ...known,
            installId: marker.installId,
            launcher: id,
            dataDir,
            gameDir,
            version: marker.version || known?.version || null,
            minecraft: marker.minecraft || known?.minecraft || null,
            loader: marker.loader || known?.loader || null,
            installedAt: known?.installedAt || marker.updatedAt || null,
            updatedAt: marker.updatedAt || known?.updatedAt || null,
          });
        }
      }
    }
    // Installs in custom places (or launchers we could not detect this time) stay while their marker exists.
    for (const r of byId.values()) {
      if (!live.has(r.installId) && (await readMarker(r.gameDir))?.installId === r.installId) live.set(r.installId, r);
    }
    const list = [...live.values()];
    saveRecords(list);
    return list;
  }

  // ── Read-only API ──────────────────────────────────────────────────────────
  /** Launchers on this computer, each with the pack's install there (or null). */
  async function detect() {
    const installs = await scanInstalls();
    const out = [];
    for (const [id, launcher] of Object.entries(launchers)) {
      for (const { dataDir } of await launcher.detect(deps.sys)) {
        const installed = installs.find((r) => r.launcher === id && r.dataDir === dataDir);
        out.push({ launcher: id, name: launcher.name, dataDir, installed: installed ? publicRecord(installed) : null });
      }
    }
    return out;
  }

  async function installs() {
    return (await scanInstalls()).map(publicRecord);
  }

  function status() {
    return {
      busy: !!job,
      job: job ? { kind: job.kind, launcher: job.launcher || null, installId: job.installId || null } : null,
      latest,
      lastError,
    };
  }

  async function loadManifest(signal) {
    const { manifest, url } = await fetchManifest(deps.source, { guardedFetch: deps.guardedFetch, fetchImpl: deps.fetchImpl, signal });
    latest = { version: manifest.version, minecraft: manifest.minecraft, loader: manifest.loader, checkedAt: Date.now() };
    return { manifest, url };
  }

  /** Fetches the manifest → { latest, installs } with updateAvailable per install. */
  async function check({ signal } = {}) {
    await loadManifest(signal);
    const list = (await scanInstalls()).map(publicRecord);
    emitStatus();
    return { latest, installs: list };
  }

  // ── Jobs ───────────────────────────────────────────────────────────────────
  async function runJob(kind, meta, fn) {
    if (job) throw new ModpackError("busy", `a ${job.kind} is running`);
    const ac = new AbortController();
    job = { kind, ac, ...meta };
    lastError = null;
    emitStatus();
    try {
      return await fn(ac.signal);
    } catch (err) {
      lastError = { code: errorCode(err), message: err?.message || String(err), at: Date.now() };
      throw err;
    } finally {
      job = null;
      emitStatus();
    }
  }

  function cancel() {
    job?.ac.abort(new ModpackError("cancelled", "cancelled"));
    return !!job;
  }

  function context(launcher, record, manifest, signal, progress) {
    return {
      sys: deps.sys,
      dataDir: record.dataDir,
      manifest,
      installId: record.installId,
      instanceName: opts.instanceName,
      memoryMB: opts.memoryMB,
      iconDataUrl: opts.iconDataUrl,
      installTimeoutMs: opts.installTimeoutMs,
      tmpDir: deps.tmpDir,
      guardedFetch: deps.guardedFetch,
      runImpl: deps.runImpl,
      openFile: deps.openFile,
      javaFor: (mcVersion) => deps.ensureJava(mcVersion, { signal, onProgress: progress }),
      signal,
      onProgress: progress,
    };
  }

  async function syncInto(record, manifest, url, signal, progress) {
    const result = await syncPack({
      gameDir: record.gameDir,
      manifest,
      resolveUrl: (u) => resolveFileUrl(url, u),
      fetch: deps.guardedFetch,
      concurrency: opts.concurrency,
      signal,
      onProgress: progress,
      fullVerify: record.fullVerify,
      download: deps.downloadOptions,
    });
    const next = {
      ...record,
      version: manifest.version,
      minecraft: manifest.minecraft,
      loader: { type: manifest.loader.type, version: manifest.loader.version },
      updatedAt: new Date().toISOString(),
    };
    delete next.fullVerify;
    await writeMarker(record.gameDir, markerFor(next));
    return { record: upsert(next), result };
  }

  function markerFor(r) {
    return {
      installId: r.installId,
      name: opts.instanceName,
      launcher: r.launcher,
      version: r.version || null,
      minecraft: r.minecraft || null,
      loader: r.loader || null,
      manifestUrl: branchManifestUrl(deps.source),
      repo: deps.source.repo || null,
      updateUrl: `aniverse://minecraft/update?install=${r.installId}`,
      needsReinstall: !!r.needsReinstall,
    };
  }

  /**
   * Installs the pack into a launcher found by detect(): { launcher, dataDir }.
   * An existing install there is updated instead.
   */
  async function install({ launcher: id, dataDir } = {}) {
    const launcher = launchers[id];
    if (!launcher) throw new ModpackError("launcher-not-found", `unknown launcher ${id}`);
    const targets = await launcher.detect(deps.sys);
    const target = dataDir ? targets.find((t) => t.dataDir === dataDir) : targets[0];
    if (!target) throw new ModpackError("launcher-not-found", `${launcher.name} is not installed`);
    const existing = (await scanInstalls()).find((r) => r.launcher === id && r.dataDir === target.dataDir);
    if (existing) return update(existing.installId);

    const installId = deps.newId();
    return runJob("install", { launcher: id, installId }, async (signal) => {
      const progress = (p) => emitProgress({ kind: "install", launcher: id, installId, ...p });
      progress({ phase: "resolving", done: 0, total: 1, bytesDone: 0, bytesTotal: 0 });
      const { manifest, url } = await loadManifest(signal);
      if (!launcher.loaderSupported(manifest)) {
        throw new ModpackError("loader-unsupported", `${launcher.name} cannot install ${manifest.loader.type}`);
      }
      let record = { installId, launcher: id, dataDir: target.dataDir, gameDir: null, installedAt: new Date().toISOString() };
      const placed = await launcher.install(context(launcher, record, manifest, signal, progress));
      record = { ...record, gameDir: placed.gameDir, ref: placed.ref };
      await writeMarker(record.gameDir, markerFor(record)); // found again even if the first sync fails
      upsert(record);
      const { record: done, result } = await syncInto(record, manifest, url, signal, progress);
      progress({ phase: "done", done: 1, total: 1, bytesDone: result.bytesDownloaded, bytesTotal: result.bytesDownloaded });
      return { install: publicRecord(done), downloaded: result.downloaded.length, removed: result.removed.length, bytes: result.bytesDownloaded };
    });
  }

  /** Waits (up to waitMs) for Minecraft to stop running from gameDir. */
  async function waitForGameClosed(gameDir, waitMs, signal) {
    const deadline = Date.now() + waitMs;
    while (await deps.isGameRunning(gameDir)) {
      if (Date.now() >= deadline) throw new ModpackError("game-running", "Minecraft is running from this install");
      await sleep(opts.gamePollMs, signal);
    }
  }

  /**
   * Updates one install (installId) or all of them. Installs whose game is running are waited for up to
   * waitForGameMs (0: fail with game-running). `verify` re-hashes every file.
   */
  async function update(installId, { waitForGameMs = 0, verify = false } = {}) {
    const all = await scanInstalls();
    const targets = installId ? all.filter((r) => r.installId === installId) : all;
    if (installId && targets.length === 0) throw new ModpackError("not-installed", `no install ${installId}`);
    return runJob("update", { installId: installId || null }, async (signal) => {
      const { manifest, url } = await loadManifest(signal);
      const results = [];
      for (const target of targets) {
        const launcher = launchers[target.launcher];
        const progress = (p) => emitProgress({ kind: "update", launcher: target.launcher, installId: target.installId, ...p });
        try {
          if (!verify && target.version === manifest.version && !target.needsReinstall) {
            results.push({ installId: target.installId, ok: true, upToDate: true });
            continue;
          }
          if (target.minecraft && target.minecraft !== manifest.minecraft && target.launcher === "modrinth") {
            throw new ModpackError("loader-unsupported", "a new Minecraft version: reinstall the pack in Modrinth App");
          }
          await waitForGameClosed(target.gameDir, waitForGameMs, signal);
          let record = { ...target, fullVerify: verify };
          const loaderChanged =
            !target.loader ||
            target.loader.type !== manifest.loader.type ||
            target.loader.version !== manifest.loader.version ||
            target.minecraft !== manifest.minecraft;
          if (loaderChanged && launcher) {
            const r = await launcher.updateLoader(target, context(launcher, target, manifest, signal, progress));
            record.needsReinstall = !r.ok;
          }
          const { record: done, result } = await syncInto(record, manifest, url, signal, progress);
          progress({ phase: "done", done: 1, total: 1, bytesDone: result.bytesDownloaded, bytesTotal: result.bytesDownloaded });
          results.push({
            installId: target.installId,
            ok: true,
            version: done.version,
            downloaded: result.downloaded.length,
            removed: result.removed.length,
            bytes: result.bytesDownloaded,
            needsReinstall: !!done.needsReinstall,
          });
        } catch (err) {
          if (signal.aborted) throw err;
          results.push({ installId: target.installId, ok: false, code: errorCode(err), message: err.message });
        }
      }
      return { version: manifest.version, results };
    });
  }

  /**
   * Plays an install: starts the game where the launcher allows it (Prism Launcher), otherwise opens the
   * launcher on the pack's profile. -> { opened: "game" | "launcher", launcherName }
   */
  async function launch(installId) {
    const record = (await scanInstalls()).find((r) => r.installId === installId);
    if (!record) throw new ModpackError("not-installed", `no install ${installId}`);
    if (job && (!job.installId || job.installId === installId)) throw new ModpackError("busy", `a ${job.kind} is running`);
    const launcher = launchers[record.launcher];
    if (!launcher?.launch) throw new ModpackError("launcher-not-found", `cannot start ${record.launcher}`);
    const { opened } = await launcher.launch(record, { sys: deps.sys, start: deps.startProgram });
    return { opened, launcherName: launcher.name };
  }

  return { detect, installs, check, install, update, launch, cancel, status };
}

module.exports = { createModpackService, DEFAULTS };
