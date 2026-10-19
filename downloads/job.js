// ─── One download job ────────────────────────────────────────────────────────
// preparing (playlists) → segments (4 parallel fetches, decrypted, written to
// the temp dir) → remux (native ffmpeg into "<final>.part.mp4", then renamed).
// kind "mp4": one ranged file download, remuxed only to add subtitles.
// Pure Node: paths, fetch and ffmpeg are injected, so it runs without
// Electron (tests, scratch runners).

const fs = require("fs");
const path = require("path");
const hls = require("./hls");
const { segmentIv, decryptAes128, findTsStart, isPackedAudio } = require("./aes");
const { buildRemuxArgs, runFfmpeg } = require("./ffmpeg");
const { disableSubtitleTracks } = require("./mp4");
const { partPathFor, uniqueOutputPath } = require("./files");
const { DownloadError } = require("./errors");

const SEGMENT_CONCURRENCY = 4;
const SPEED_WINDOW_MS = 5000;
const SPEED_TICK_MS = 1000;
const PACKED_AUDIO_EXT = /\.(aac|mp3|ac3|ec3|eac3)$/i;

// ── Pause gate ──────────────────────────────────────────────────────────────
// pause() aborts the in-flight requests (gate.signal); the work waits in
// wait() and redoes them after resume().

function createPauseGate() {
  let paused = false;
  let controller = new AbortController();
  let waiters = [];
  return {
    get paused() {
      return paused;
    },
    get signal() {
      return controller.signal;
    },
    pause() {
      if (paused) return false;
      paused = true;
      const err = new Error("pause");
      err.name = "AbortError";
      err.kind = "pause";
      controller.abort(err);
      return true;
    },
    resume() {
      if (!paused) return false;
      paused = false;
      controller = new AbortController();
      waiters.splice(0).forEach((release) => release());
      return true;
    },
    wait(signal) {
      if (signal?.aborted) return Promise.reject(signal.reason);
      if (!paused) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const onAbort = () => {
          waiters = waiters.filter((w) => w !== release);
          reject(signal.reason);
        };
        const release = () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        waiters.push(release);
      });
    },
  };
}

// Runs fn(signal) until it completes; a pause mid-way restarts it after resume.
async function pausable(ctx, fn) {
  for (;;) {
    if (ctx.signal.aborted) throw ctx.signal.reason;
    await ctx.gate.wait(ctx.signal);
    const pauseSignal = ctx.gate.signal;
    try {
      return await fn(AbortSignal.any([ctx.signal, pauseSignal]));
    } catch (err) {
      if (ctx.signal.aborted) throw ctx.signal.reason;
      if (pauseSignal.aborted) continue;
      throw err;
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function withUserAgent(headers, userAgent) {
  const copy = { ...(headers || {}) };
  const hasAgent = Object.keys(copy).some((k) => k.toLowerCase() === "user-agent");
  if (userAgent && !hasAgent) copy["User-Agent"] = userAgent;
  return copy;
}

function createSpeedMeter(now) {
  const samples = []; // [time, bytes], bucketed per 100 ms
  return {
    add(bytes) {
      const t = now();
      const last = samples[samples.length - 1];
      if (last && t - last[0] < 100) last[1] += bytes;
      else samples.push([t, bytes]);
    },
    get() {
      const t = now();
      while (samples.length && t - samples[0][0] > SPEED_WINDOW_MS) samples.shift();
      if (!samples.length) return 0;
      const bytes = samples.reduce((sum, s) => sum + s[1], 0);
      return Math.round((bytes * 1000) / Math.max(1000, t - samples[0][0]));
    },
  };
}

async function rmSafe(target) {
  try {
    await fs.promises.rm(target, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
  } catch (_) {}
}

function segmentExtension(uri) {
  try {
    const m = PACKED_AUDIO_EXT.exec(new URL(uri).pathname);
    return m ? m[0].toLowerCase() : ".ts";
  } catch {
    return ".ts";
  }
}

function checkSegment(buf, task) {
  if (task.type === "init" || task.fmp4) {
    if (!buf.length) {
      throw new DownloadError("unsupported", "empty segment", { retryable: true });
    }
    return buf;
  }
  const start = findTsStart(buf);
  if (start === 0) return buf;
  if (start > 0) return buf.subarray(start);
  if (PACKED_AUDIO_EXT.test(task.file) && isPackedAudio(buf)) return buf;
  throw new DownloadError("unsupported", "segment is not MPEG-TS", { retryable: true });
}

async function fetchPlaylist(http, url, headers, signal) {
  return http.getBuffer(url, {
    headers,
    signal,
    transform: (buf, res) => {
      const text = buf.toString("utf8");
      if (!hls.isPlaylist(text)) {
        throw new DownloadError("unsupported", "not an HLS playlist", { retryable: true });
      }
      // Relative URIs resolve against the playlist's final (redirected) URL.
      return { text, url: res.url || url };
    },
  });
}

async function loadPlaylists(ctx, headers, signal) {
  const { http, request } = ctx;
  const first = await fetchPlaylist(http, request.source, headers, signal);
  let media = first;
  let quality = null;
  let audio = null;

  if (hls.isMasterPlaylist(first.text)) {
    const master = hls.parseMaster(first.text, first.url);
    const variant = hls.pickVariant(master.variants, request.maxHeight);
    if (!variant) throw new DownloadError("unsupported", "master playlist without variants");
    quality = hls.qualityLabel(variant);
    ctx.report({ progress: 1 });
    media = await fetchPlaylist(http, variant.uri, headers, signal);
    if (hls.isMasterPlaylist(media.text)) {
      throw new DownloadError("unsupported", "nested master playlist");
    }
    const rendition = hls.pickAudioRendition(master, variant);
    if (rendition) {
      const audioPlaylist = await fetchPlaylist(http, rendition.uri, headers, signal);
      audio = hls.parseMedia(audioPlaylist.text, audioPlaylist.url);
    }
  }

  const video = hls.parseMedia(media.text, media.url);
  for (const playlist of [video, audio]) {
    if (!playlist) continue;
    if (!playlist.endList) {
      throw new DownloadError("unsupported", "live playlist (no EXT-X-ENDLIST)");
    }
    if (!playlist.segments.length) {
      throw new DownloadError("unsupported", "playlist without segments");
    }
  }
  return { video, audio, quality };
}

// Test-only cap (scratch runners): the first `limit` video segments and the
// audio segments covering the same time.
function applySegmentLimit(video, audio, limit) {
  if (!(limit > 0) || video.segments.length <= limit) return;
  video.segments = video.segments.slice(0, limit);
  video.totalDuration = video.segments.reduce((sum, s) => sum + s.duration, 0);
  if (audio) {
    let time = 0;
    audio.segments = audio.segments.filter((s) => {
      const keep = time < video.totalDuration;
      time += s.duration;
      return keep;
    });
    audio.totalDuration = audio.segments.reduce((sum, s) => sum + s.duration, 0);
  }
}

function writeSubtitles(tmpDir, subtitles) {
  if (!subtitles.length) return [];
  fs.mkdirSync(path.join(tmpDir, "subs"), { recursive: true });
  return subtitles.map((sub, i) => {
    const file = `subs/${i}.${sub.format}`;
    fs.writeFileSync(path.join(tmpDir, file), sub.content, "utf8");
    return { file, format: sub.format, locale: sub.locale, label: sub.label };
  });
}

async function remux(ctx, { input, audio, subtitles, totalSeconds }, partPath) {
  await rmSafe(partPath);
  const args = buildRemuxArgs({
    input,
    audio,
    subtitles,
    language: ctx.request.language,
    output: partPath,
  });
  await runFfmpeg({
    ffmpegPath: ctx.ffmpegPath,
    args,
    cwd: ctx.tmpDir,
    signal: ctx.signal,
    totalSeconds,
    onProgress: (fraction) => ctx.report({ progress: Math.min(99.9, 95 + 5 * fraction) }),
    spawnImpl: ctx.spawn,
  });
  // VF: no subtitle track is shown by default (the muxer enables the first).
  if (ctx.request.language !== "sub" && subtitles.length) {
    try {
      disableSubtitleTracks(partPath);
    } catch (err) {
      console.warn("[download] could not clear the subtitle default flag:", err.message);
    }
  }
}

// Renames the part file; a file that appeared meanwhile is never overwritten.
function finalize(ctx, partPath) {
  let outputPath = ctx.outputPath;
  if (fs.existsSync(outputPath)) {
    const claim =
      ctx.claimOutputPath ||
      (() =>
        uniqueOutputPath(
          path.dirname(outputPath),
          path.basename(outputPath),
          (p) => fs.existsSync(p) || (p !== outputPath && fs.existsSync(partPathFor(p))),
        ));
    outputPath = claim().outputPath;
  }
  fs.renameSync(partPath, outputPath);
  return {
    outputPath,
    fileName: path.basename(outputPath),
    sizeBytes: fs.statSync(outputPath).size,
  };
}

// ── HLS ─────────────────────────────────────────────────────────────────────

async function runHls(ctx, headers, partPath, speed) {
  const { http, tmpDir, report } = ctx;

  const { video, audio, quality } = await pausable(ctx, (signal) =>
    loadPlaylists(ctx, headers, signal),
  );
  applySegmentLimit(video, audio, ctx.segmentLimit);

  // Tasks: init sections (once each), then the media segments.
  const tasks = [];
  const initFiles = new Map();
  const entries = { video: [], audio: [] };
  for (const [name, playlist] of [
    ["video", video],
    ["audio", audio],
  ]) {
    if (!playlist) continue;
    fs.mkdirSync(path.join(tmpDir, name), { recursive: true });
    playlist.segments.forEach((seg, i) => {
      let mapFile = null;
      if (seg.map) {
        const range = seg.map.byteRange;
        const mapKey = `${name}|${seg.map.uri}|${range?.offset}|${range?.length}`;
        if (!initFiles.has(mapKey)) {
          const file = `${name}/init-${initFiles.size}.mp4`;
          initFiles.set(mapKey, file);
          tasks.push({
            type: "init",
            uri: seg.map.uri,
            byteRange: range,
            key: seg.map.key,
            seq: seg.seq,
            file,
          });
        }
        mapFile = initFiles.get(mapKey);
      }
      const ext = seg.map ? ".m4s" : segmentExtension(seg.uri);
      const file = `${name}/${String(i).padStart(5, "0")}${ext}`;
      tasks.push({
        type: "segment",
        uri: seg.uri,
        byteRange: seg.byteRange,
        key: seg.key,
        seq: seg.seq,
        file,
        fmp4: !!seg.map,
      });
      entries[name].push({
        file,
        duration: seg.duration,
        discontinuity: seg.discontinuity,
        mapFile,
      });
    });
  }

  const segmentsTotal = tasks.filter((t) => t.type === "segment").length;
  let segmentsDone = 0;
  let bytesDownloaded = 0;
  report({
    quality,
    phase: "segments",
    progress: 2,
    segmentsDone,
    segmentsTotal,
    bytesDownloaded,
  });

  // Keys: fetched once per URI with the stream headers.
  const keys = new Map();
  const getKey = (key, signal) => {
    let pending = keys.get(key.uri);
    if (!pending) {
      pending = http.getBuffer(key.uri, {
        headers,
        signal,
        checkHtml: "header",
        transform: (buf) => {
          if (buf.length !== 16) {
            throw new DownloadError("forbidden", `AES-128 key is ${buf.length} bytes`, {
              retryable: true,
            });
          }
          return buf;
        },
      });
      keys.set(key.uri, pending);
      pending.catch(() => keys.delete(key.uri));
    }
    return pending;
  };

  const fetchTask = async (task, signal) => {
    const keyBytes = task.key ? await getKey(task.key, signal) : null;
    const range = task.byteRange;
    const data = await http.getBuffer(task.uri, {
      headers: range
        ? { ...headers, Range: `bytes=${range.offset}-${range.offset + range.length - 1}` }
        : headers,
      signal,
      checkHtml: task.key ? "header" : "body",
      onChunk: (n) => speed.add(n),
      transform: (body, res) => {
        let buf = body;
        if (range) {
          // A server that ignores Range sends the whole resource.
          if (res.status !== 206) buf = buf.subarray(range.offset, range.offset + range.length);
          if (buf.length !== range.length) {
            throw new DownloadError("network", "short byte range", { retryable: true });
          }
        }
        if (keyBytes) buf = decryptAes128(buf, keyBytes, segmentIv(task.key, task.seq));
        return checkSegment(buf, task);
      },
    });
    const target = path.join(tmpDir, task.file);
    await fs.promises.writeFile(`${target}.part`, data);
    await fs.promises.rename(`${target}.part`, target);

    if (task.type === "segment") {
      segmentsDone++;
      bytesDownloaded += data.length;
      report({
        segmentsDone,
        bytesDownloaded,
        speedBps: ctx.gate.paused ? 0 : speed.get(),
        progress: 2 + (93 * segmentsDone) / segmentsTotal,
      });
    }
  };

  // Pool of 4: the first failure stops the others.
  const failure = new AbortController();
  const scope = { ...ctx, signal: AbortSignal.any([ctx.signal, failure.signal]) };
  let next = 0;
  let error = null;
  const worker = async () => {
    while (!error && next < tasks.length) {
      const task = tasks[next++];
      try {
        await pausable(scope, (signal) => fetchTask(task, signal));
      } catch (err) {
        if (!error) {
          error = err;
          failure.abort(err);
        }
        return;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(SEGMENT_CONCURRENCY, tasks.length) }, worker),
  );
  if (ctx.signal.aborted) throw ctx.signal.reason;
  if (error) throw error;

  ctx.measuring = false;
  report({ progress: 95, speedBps: 0 });
  await ctx.gate.wait(ctx.signal); // a pause right at the end holds the remux

  fs.writeFileSync(path.join(tmpDir, "video.m3u8"), hls.buildLocalPlaylist(entries.video));
  if (audio) {
    fs.writeFileSync(path.join(tmpDir, "audio.m3u8"), hls.buildLocalPlaylist(entries.audio));
  }
  const subtitles = writeSubtitles(tmpDir, ctx.request.subtitles);
  report({ phase: "remux", progress: 95 });
  await remux(
    ctx,
    {
      input: { file: "video.m3u8", playlist: true },
      audio: audio ? "audio.m3u8" : null,
      subtitles,
      totalSeconds: video.totalDuration,
    },
    partPath,
  );
  return finalize(ctx, partPath);
}

// ── Direct file (kind "mp4") ────────────────────────────────────────────────

async function runDirect(ctx, headers, partPath, speed) {
  const { http, tmpDir, report, request } = ctx;
  const withSubtitles = request.subtitles.length > 0;
  const target = withSubtitles ? path.join(tmpDir, "source.mp4") : partPath;
  if (!withSubtitles) await rmSafe(partPath);

  let total = null;
  report({ phase: "segments", progress: 2, bytesDownloaded: 0 });
  await pausable(ctx, (signal) =>
    http.downloadToFile(request.source, target, {
      headers,
      signal,
      onTotal: (t) => {
        total = t;
      },
      onChunk: (n, size) => {
        speed.add(n);
        report({
          bytesDownloaded: size,
          progress: total ? 2 + (93 * Math.min(size, total)) / total : 2,
        });
      },
    }),
  );
  ctx.measuring = false;
  report({ progress: 95, speedBps: 0 });
  await ctx.gate.wait(ctx.signal);

  if (withSubtitles) {
    const subtitles = writeSubtitles(tmpDir, request.subtitles);
    report({ phase: "remux", progress: 95 });
    await remux(
      ctx,
      { input: { file: "source.mp4", playlist: false }, audio: null, subtitles },
      partPath,
    );
  }
  return finalize(ctx, partPath);
}

/**
 * ctx: { request, outputPath, tmpDir, signal, gate?, http, ffmpegPath,
 *        userAgent?, report(patch), claimOutputPath?, segmentLimit?, now?, spawn? }
 * Resolves { outputPath, fileName, sizeBytes }; the temp dir is always
 * removed, the part file too unless the job succeeded.
 */
async function runJob(input) {
  const ctx = { ...input, gate: input.gate || createPauseGate(), now: input.now || Date.now };
  const headers = withUserAgent(ctx.request.headers, ctx.userAgent);
  const partPath = partPathFor(ctx.outputPath);
  const speed = createSpeedMeter(ctx.now);
  // Speed refresh while bytes flow (a long segment would leave it stale).
  ctx.measuring = true;
  const ticker = setInterval(() => {
    if (ctx.measuring && !ctx.gate.paused) ctx.report({ speedBps: speed.get() });
  }, SPEED_TICK_MS);
  ticker.unref?.();

  let succeeded = false;
  try {
    // Without ffmpeg an HLS episode (or an mp4 with subtitles) can't be
    // finished: said now, not after downloading the whole episode.
    const needsFfmpeg = ctx.request.kind !== "mp4" || ctx.request.subtitles.length > 0;
    if (needsFfmpeg && !ctx.ffmpegPath) {
      throw new DownloadError("ffmpeg", "ffmpeg binary not found");
    }
    fs.mkdirSync(ctx.tmpDir, { recursive: true });
    fs.mkdirSync(path.dirname(ctx.outputPath), { recursive: true });
    const result =
      ctx.request.kind === "mp4"
        ? await runDirect(ctx, headers, partPath, speed)
        : await runHls(ctx, headers, partPath, speed);
    succeeded = true;
    return result;
  } finally {
    clearInterval(ticker);
    if (succeeded) {
      // The file is final: the job is reported done at once while the
      // segments go (hundreds of files, slow on Windows). Awaited, a cancel
      // in that time marked a finished file cancelled and lost track of it.
      // What a quit leaves behind is cleared at the next start.
      void rmSafe(ctx.tmpDir);
    } else {
      await rmSafe(ctx.tmpDir);
      await rmSafe(partPath);
    }
  }
}

module.exports = {
  runJob,
  createPauseGate,
  pausable,
  withUserAgent,
  fetchPlaylist,
  createSpeedMeter,
  checkSegment,
  segmentExtension,
  applySegmentLimit,
  SEGMENT_CONCURRENCY,
};
