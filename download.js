const path = require("path");
const https = require("https");
const http = require("http");
const fs = require("fs");
const os = require("os");
const { FFmpeg } = require("@ffmpeg/ffmpeg");
const { fetchFile } = require("@ffmpeg/util");

let mainWindow = null;
let store = null;

// ─── Active download registry ────────────────────────────────────────────────
// Maps id → { controller, pauseSignal }
const activeDownloads = new Map();

// ─── Init ────────────────────────────────────────────────────────────────────

function initDownload(newMainWindow, newStore) {
  mainWindow = newMainWindow;
  store = newStore;
}

// ─── IPC helper ──────────────────────────────────────────────────────────────

function sendToRenderer(channel, payload) {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, payload);
    }
  } catch (_) {}
}

// ─── Store helpers ───────────────────────────────────────────────────────────

function upsertDownload(record) {
  if (!store) return;

  const all = getDownloads();
  const idx = all.findIndex((d) => d.id === record.id);

  if (idx === -1) {
    all.unshift(record);
  } else {
    all[idx] = { ...all[idx], ...record };
  }

  store.set("downloads", all);
  sendToRenderer("download:update", record);
}

function getDownloads() {
  const raw = store ? store.get("downloads") : null;
  return Array.isArray(raw) ? raw : [];
}

// ─── Pause signal ─────────────────────────────────────────────────────────────

function makePauseSignal() {
  let paused = false;
  let resolveFn = null;

  return {
    get paused() {
      return paused;
    },
    pause() {
      paused = true;
    },
    resume() {
      paused = false;
      if (resolveFn) {
        resolveFn();
        resolveFn = null;
      }
    },
    async wait() {
      if (!paused) return;
      await new Promise((resolve) => {
        resolveFn = resolve;
      });
    },
  };
}

// ─── Control functions ────────────────────────────────────────────────────────

function pauseDownload(id) {
  const entry = activeDownloads.get(id);
  if (!entry) return false;

  entry.pauseSignal.pause();
  upsertDownload({ id, status: "paused", statusText: "Paused" });
  return true;
}

function resumeDownload(id) {
  const entry = activeDownloads.get(id);
  if (!entry) return false;

  entry.pauseSignal.resume();
  upsertDownload({ id, status: "downloading", statusText: "Resuming…" });
  return true;
}

function cancelDownload(id) {
  const entry = activeDownloads.get(id);
  if (!entry) return false;

  entry.controller.cancelled = true;
  entry.pauseSignal.resume(); // unblock if paused so the loop can exit
  return true;
}

/**
 * Remove a download from history.
 * If still active it will be cancelled first.
 * Pass { deleteFile: true } to also remove the output file from disk.
 */
function deleteDownload(id, { deleteFile = false } = {}) {
  cancelDownload(id); // no-op if already finished

  if (!store) return false;

  const all = getDownloads();
  const record = all.find((d) => d.id === id);

  if (deleteFile && record?.outputPath) {
    try {
      if (fs.existsSync(record.outputPath)) fs.unlinkSync(record.outputPath);
    } catch (_) {}
  }

  store.set(
    "downloads",
    all.filter((d) => d.id !== id),
  );
  sendToRenderer("download:deleted", { id });
  return true;
}

// ─── Network helpers ─────────────────────────────────────────────────────────

function fetchText(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    lib
      .get(url, { headers: extraHeaders }, (res) => {
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          return resolve(fetchText(res.headers.location, extraHeaders));
        }
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve(data));
        res.on("error", reject);
      })
      .on("error", reject);
  });
}

function fetchBuffer(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    lib
      .get(url, { headers: extraHeaders }, (res) => {
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          return resolve(fetchBuffer(res.headers.location, extraHeaders));
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks)));
        res.on("error", reject);
      })
      .on("error", reject);
  });
}

// ─── M3U8 parsing ────────────────────────────────────────────────────────────

function resolveUrl(base, relative) {
  if (!relative) return base;
  if (relative.startsWith("http://") || relative.startsWith("https://")) {
    return relative;
  }
  const baseDir = base.split("/").slice(0, -1).join("/");
  return `${baseDir}/${relative}`;
}

function parseMasterPlaylist(text, masterUrl, preferredQuality) {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const variants = [];

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("#EXT-X-STREAM-INF:")) {
      const info = lines[i];
      const uri = lines[i + 1];
      if (!uri || uri.startsWith("#")) continue;

      const bwMatch = info.match(/BANDWIDTH=(\d+)/);
      const resMatch = info.match(/RESOLUTION=([0-9x]+)/);

      variants.push({
        bandwidth: bwMatch ? parseInt(bwMatch[1]) : 0,
        resolution: resMatch ? resMatch[1] : "",
        uri: resolveUrl(masterUrl, uri),
        raw: info,
      });
      i++;
    }
  }

  if (!variants.length) return null;

  variants.sort((a, b) => b.bandwidth - a.bandwidth);

  if (preferredQuality) {
    const match = variants.find(
      (v) =>
        v.resolution.includes(preferredQuality) ||
        v.raw.includes(preferredQuality),
    );
    if (match) return match.uri;
  }

  return variants[0].uri;
}

function parseMediaPlaylist(text, playlistUrl) {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const segments = [];

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("#EXTINF:")) {
      const uri = lines[i + 1];
      if (uri && !uri.startsWith("#")) {
        segments.push(resolveUrl(playlistUrl, uri));
        i++;
      }
    }
  }

  return segments;
}

// ─── Subtitle helpers ─────────────────────────────────────────────────────────

function extFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    const dot = pathname.lastIndexOf(".");
    if (dot !== -1) return pathname.slice(dot + 1).toLowerCase();
  } catch (_) {
    const clean = (url || "").split("?")[0];
    const dot = clean.lastIndexOf(".");
    if (dot !== -1) return clean.slice(dot + 1).toLowerCase();
  }
  return "vtt";
}

// ─── Main download function ───────────────────────────────────────────────────

async function downloadM3U8ToMP4(masterUrl, metadata = {}) {
  const id = crypto.randomUUID();
  const fileName = `${metadata.title || "video"}.mp4`;
  const outputDir = metadata.outputDir || path.join(os.homedir(), "Downloads");
  const outputPath = path.join(outputDir, fileName);
  const headers = metadata.headers || {};
  const tmpDir = path.join(os.tmpdir(), `vumeto-${id}`);

  const controller = { cancelled: false };
  const pauseSignal = makePauseSignal();
  activeDownloads.set(id, { controller, pauseSignal });

  const update = (progress, statusText, extra = {}) => {
    upsertDownload({
      id,
      fileName,
      masterUrl,
      progress,
      statusText,
      outputPath,
      ...extra,
    });
  };

  const checkCancelled = () => {
    if (controller.cancelled) throw new Error("CANCELLED");
  };

  try {
    update(2, "Fetching playlist…", {
      status: "downloading",
      startedAt: Date.now(),
    });
    fs.mkdirSync(tmpDir, { recursive: true });

    // ── Step 1: Master playlist ────────────────────────────────────────────
    checkCancelled();
    const masterText = await fetchText(masterUrl, headers);

    // ── Step 2: Resolve media playlist ────────────────────────────────────
    checkCancelled();
    let playlistUrl = masterUrl;
    const variantUrl = parseMasterPlaylist(
      masterText,
      masterUrl,
      metadata.quality,
    );
    if (variantUrl) playlistUrl = variantUrl;

    update(5, "Parsing segments…");

    // ── Step 3: Parse segments ─────────────────────────────────────────────
    checkCancelled();
    const playlistText = variantUrl
      ? await fetchText(playlistUrl, headers)
      : masterText;

    const segments = parseMediaPlaylist(playlistText, playlistUrl);
    if (!segments.length) throw new Error("No segments found in playlist.");

    update(8, `Found ${segments.length} segments…`);

    // ── Step 4: Download segments (pause / cancel aware) ───────────────────
    const segmentFiles = [];

    for (let i = 0; i < segments.length; i++) {
      checkCancelled();
      await pauseSignal.wait(); // ← blocks here while paused
      checkCancelled(); // ← re-check after resume

      const segPath = path.join(tmpDir, `seg${String(i).padStart(5, "0")}.ts`);
      segmentFiles.push(segPath);

      const buf = await fetchBuffer(segments[i], headers);
      fs.writeFileSync(segPath, buf);

      const percent = 8 + ((i + 1) / segments.length) * 72; // 8 → 80
      update(percent, `Downloading segment ${i + 1} / ${segments.length}…`, {
        status: pauseSignal.paused ? "paused" : "downloading",
      });
    }

    // ── Step 5: Concatenate ────────────────────────────────────────────────
    checkCancelled();
    update(82, "Merging segments…");

    const combinedPath = path.join(tmpDir, "combined.ts");
    const out = fs.createWriteStream(combinedPath);

    await new Promise((resolve, reject) => {
      const writeNext = (index) => {
        if (index >= segmentFiles.length) {
          out.end();
          return;
        }
        const chunk = fs.readFileSync(segmentFiles[index]);
        out.write(chunk, () => writeNext(index + 1));
      };
      out.on("finish", resolve);
      out.on("error", reject);
      writeNext(0);
    });

    // ── Step 6: FFmpeg ─────────────────────────────────────────────────────
    checkCancelled();
    update(85, "Starting FFmpeg…");

    const ffmpeg = new FFmpeg({ log: false });

    ffmpeg.on?.("progress", ({ progress, ratio }) => {
      if (controller.cancelled) return;
      const value =
        typeof progress === "number"
          ? progress
          : typeof ratio === "number"
            ? ratio
            : 0;
      update(85 + value * 12, "Converting…"); // 85 → 97
    });

    await ffmpeg.load();
    checkCancelled();

    await ffmpeg.writeFile("input.ts", await fetchFile(combinedPath));

    const subtitles = (metadata.subtitles || []).map((s) => {
      const langSlug = (s.language || "sub").split(" ")[0].toLowerCase();
      const ext = extFromUrl(s.file);
      return { ...s, langSlug, ext, fileName: `${langSlug}.${ext}` };
    });

    for (const sub of subtitles) {
      checkCancelled();
      const subBuf = await fetchBuffer(sub.file, headers);
      await ffmpeg.writeFile(sub.fileName, subBuf);
    }

    const defaultIndex = subtitles.findIndex((s) => s.default);

    const args = [
      "-i",
      "input.ts",
      ...subtitles.flatMap((s) => ["-i", s.fileName]),
      "-map",
      "0:v",
      "-map",
      "0:a?",
      ...subtitles.flatMap((_, idx) => ["-map", `${idx + 1}`]),
      "-c",
      "copy",
      "-c:s",
      "mov_text",
    ];

    if (subtitles.length > 0) {
      args.push(
        `-disposition:s:${defaultIndex >= 0 ? defaultIndex : 0}`,
        "default",
      );
      subtitles.forEach((s, idx) => {
        args.push(
          `-metadata:s:s:${idx}`,
          `language=${s.langSlug}`,
          `-metadata:s:s:${idx}`,
          `title=${s.language}`,
        );
      });
    }

    args.push("output.mp4");

    await ffmpeg.exec(args);
    checkCancelled();

    // ── Step 7: Write output ───────────────────────────────────────────────
    update(97, "Saving file…");
    const data = await ffmpeg.readFile("output.mp4");
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(outputPath, Buffer.from(data.buffer));

    // ── Step 8: Cleanup ────────────────────────────────────────────────────
    fs.rmSync(tmpDir, { recursive: true, force: true });
    activeDownloads.delete(id);

    update(100, "Done", { status: "completed", finishedAt: Date.now() });
    console.log(`✅ Download complete: ${outputPath}`);
    return { id, outputPath };
  } catch (err) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {}
    activeDownloads.delete(id);

    if (err.message === "CANCELLED") {
      upsertDownload({
        id,
        fileName,
        masterUrl,
        progress: 0,
        status: "cancelled",
        statusText: "Cancelled",
        outputPath,
        finishedAt: Date.now(),
      });
      console.log(`🚫 Download cancelled: ${id}`);
      return { id, cancelled: true };
    }

    console.error("downloadM3U8ToMP4 error:", err);
    upsertDownload({
      id,
      fileName,
      masterUrl,
      progress: 0,
      status: "error",
      statusText: "Failed",
      outputPath,
      error: err.message,
      finishedAt: Date.now(),
    });
    throw err;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

module.exports = {
  initDownload,
  downloadM3U8ToMP4,
  getDownloads,
  pauseDownload,
  resumeDownload,
  cancelDownload,
  deleteDownload,
};
