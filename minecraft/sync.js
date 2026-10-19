// ─── Modpack sync ────────────────────────────────────────────────────────────
// Brings a game directory to a manifest (pack-tool/README.md "To install or
// update"):
//   1. every path was validated when the manifest was parsed;
//   2. "once" files are skipped when they exist (the player's keybinds and
//      video settings win), other files when their size + sha1 already match;
//   3. the rest is downloaded in parallel, checked for size + sha1 and
//      renamed into place;
//   4. files in managed_dirs that the manifest does not list are deleted
//      (removed and updated mods). Other folders are never cleaned.
// `.aniverse/state.json` caches each file's sha1 by size + mtime so a check
// does not re-hash ~1 GB of mods; `fullVerify` ignores the cache.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { ModpackError } = require("./errors");
const { downloadFile, runPool } = require("./download");
const { assertNoSymlinks, normalizeRelPath, pathKey, safeJoin } = require("./paths");

const META_DIR = ".aniverse";
const STATE_FILE = "state.json";

const metaDir = (gameDir) => path.join(gameDir, META_DIR);
const stateFile = (gameDir) => path.join(metaDir(gameDir), STATE_FILE);

async function readJson(file) {
  try {
    return JSON.parse(await fs.promises.readFile(file, "utf8"));
  } catch (_) {
    return null;
  }
}

async function writeJsonAtomic(file, value) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(value, null, 2));
  try {
    await fs.promises.rename(tmp, file);
  } catch (err) {
    await fs.promises.rm(tmp, { force: true });
    throw err;
  }
}

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha1");
    fs.createReadStream(file)
      .on("data", (c) => h.update(c))
      .on("error", reject)
      .on("end", () => resolve(h.digest("hex")));
  });
}

async function readState(gameDir) {
  const s = await readJson(stateFile(gameDir));
  return s && s.format === 1 && s.files && typeof s.files === "object" ? s : null;
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

/** One writer per game directory (.aniverse/lock holds the owner's pid; a dead owner's lock is taken over). */
async function acquireLock(gameDir) {
  await fs.promises.mkdir(metaDir(gameDir), { recursive: true });
  const file = path.join(metaDir(gameDir), "lock");
  for (let i = 0; i < 2; i++) {
    try {
      const fh = await fs.promises.open(file, "wx");
      await fh.writeFile(String(process.pid));
      await fh.close();
      return () => fs.promises.rm(file, { force: true });
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      const pid = Number((await fs.promises.readFile(file, "utf8").catch(() => "")).trim());
      if (alive(pid)) throw new ModpackError("busy", "this game directory is being updated");
      await fs.promises.rm(file, { force: true });
    }
  }
  throw new ModpackError("busy", "this game directory is being updated");
}

async function defaultFreeBytes(dir) {
  try {
    const s = await fs.promises.statfs(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch (_) {
    return null;
  }
}

/** Files (not symlinks) under relDir as "dir/sub/name"; names we could never write are left alone. */
async function listFiles(root, relDir, out, depth = 0) {
  if (depth > 8 || out.length > 50_000) return;
  let entries;
  try {
    entries = await fs.promises.readdir(path.join(root, ...relDir.split("/")), { withFileTypes: true });
  } catch (_) {
    return;
  }
  for (const d of entries) {
    const rel = `${relDir}/${d.name}`;
    try {
      normalizeRelPath(rel);
    } catch (_) {
      continue;
    }
    if (d.isSymbolicLink()) continue;
    if (d.isDirectory()) await listFiles(root, rel, out, depth + 1);
    else if (d.isFile()) out.push(rel);
  }
}

/**
 * opts: {
 *   gameDir, manifest, resolveUrl(url) → absolute url, fetch (guarded),
 *   concurrency = 6, fullVerify, signal, onProgress({ phase, done, total, bytesDone, bytesTotal }),
 *   freeBytes(dir), download: { attempts, backoffMs } (tests)
 * }
 * → { version, downloaded: [paths], bytesDownloaded, removed: [paths] }
 */
async function syncPack(opts) {
  const { gameDir, manifest, signal } = opts;
  const report = (p) => opts.onProgress?.(p);
  const total = manifest.files.length;
  report({ phase: "checking", done: 0, total, bytesDone: 0, bytesTotal: 0 });

  const targets = manifest.files.map((file) => ({ file, dest: safeJoin(gameDir, file.path) }));
  await fs.promises.mkdir(gameDir, { recursive: true });
  const release = await acquireLock(gameDir);
  try {
    const prev = await readState(gameDir);
    const hashes = {};
    const toDownload = [];

    // 1. What is already there.
    let checked = 0;
    await runPool(
      targets,
      4,
      async (t) => {
        const { file, dest } = t;
        await assertNoSymlinks(gameDir, file.path);
        const st = await fs.promises.lstat(dest).catch(() => null);
        if (st?.isDirectory()) throw new ModpackError("invalid-manifest", `a folder is in the way of ${file.path}`);
        let good = false;
        if (st && file.mode === "once") {
          good = true;
        } else if (st && st.size === file.size) {
          const mtimeMs = Math.floor(st.mtimeMs);
          const cached = prev?.files[file.path];
          const sha1 =
            !opts.fullVerify && cached && cached.size === st.size && cached.mtimeMs === mtimeMs
              ? cached.sha1
              : await hashFile(dest);
          good = sha1 === file.sha1;
          if (good) hashes[file.path] = { size: st.size, mtimeMs, sha1 };
        }
        if (!good) toDownload.push(t);
        checked++;
        report({ phase: "checking", done: checked, total, bytesDone: 0, bytesTotal: 0 });
      },
      signal,
    );

    // 2. Download what is missing or different.
    const bytesTotal = toDownload.reduce((n, t) => n + t.file.size, 0);
    const free = await (opts.freeBytes ?? defaultFreeBytes)(gameDir);
    const need = Math.ceil(bytesTotal * 1.1);
    if (free !== null && need > 0 && free < need) throw new ModpackError("disk-full", `need ${need} bytes, have ${free}`);

    const partsDir = path.join(metaDir(gameDir), "downloads");
    const downloaded = [];
    let bytesDone = 0;
    if (toDownload.length > 0) {
      const progress = () =>
        report({ phase: "downloading", done: downloaded.length, total: toDownload.length, bytesDone, bytesTotal });
      progress();
      await runPool(
        toDownload,
        Math.min(16, Math.max(1, opts.concurrency ?? 6)),
        async (t, poolSignal) => {
          const tag = crypto.createHash("sha1").update(pathKey(t.file.path)).digest("hex").slice(0, 8);
          await downloadFile(
            {
              id: t.file.path,
              url: opts.resolveUrl(t.file.url),
              dest: t.dest,
              part: path.join(partsDir, `${t.file.sha1}-${tag}.part`),
              size: t.file.size,
              sha1: t.file.sha1,
            },
            {
              ...opts.download,
              fetch: opts.fetch,
              signal: poolSignal,
              onBytes: (d) => {
                bytesDone += d;
                progress();
              },
            },
          );
          downloaded.push(t.file.path);
          if (t.file.mode !== "once") {
            const st = await fs.promises.lstat(t.dest);
            hashes[t.file.path] = { size: st.size, mtimeMs: Math.floor(st.mtimeMs), sha1: t.file.sha1 };
          }
          progress();
        },
        signal,
      );
    }
    await fs.promises.rm(partsDir, { recursive: true, force: true });

    // 3. Clean managed dirs.
    const wanted = new Set(manifest.files.map((f) => pathKey(f.path)));
    const removed = [];
    for (const dir of manifest.managed_dirs) {
      await assertNoSymlinks(gameDir, dir, { includeLeaf: true });
      const listed = [];
      await listFiles(gameDir, dir, listed);
      for (const rel of listed) {
        if (wanted.has(pathKey(rel))) continue;
        await fs.promises.rm(safeJoin(gameDir, rel), { force: true });
        removed.push(rel);
      }
    }

    await writeJsonAtomic(stateFile(gameDir), { format: 1, version: manifest.version, files: hashes, updatedAt: Date.now() });
    return { version: manifest.version, downloaded: downloaded.sort(), bytesDownloaded: bytesTotal, removed: removed.sort() };
  } finally {
    await release();
  }
}

module.exports = { syncPack, readState, readJson, writeJsonAtomic, hashFile, metaDir, META_DIR };
