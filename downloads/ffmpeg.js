// ─── Native ffmpeg ───────────────────────────────────────────────────────────
// Only the final local remux: decrypted segments (local playlist) or a
// downloaded file + subtitle text → one .mp4 with mov_text subtitles.
// Packaged builds ship the binary in resources/ffmpeg (electron-builder
// extraResources, per platform/arch); dev uses ffmpeg-static.

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { DownloadError } = require("./errors");

function executableName(platform = process.platform) {
  return platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
}

function resolveFfmpegPath({
  isPackaged,
  resourcesPath,
  platform = process.platform,
  existsSync = fs.existsSync,
  requireStatic = () => require("ffmpeg-static"),
} = {}) {
  let candidate = null;
  if (isPackaged) {
    candidate = path.join(resourcesPath || "", "ffmpeg", executableName(platform));
  } else {
    try {
      candidate = requireStatic();
    } catch (_) {
      candidate = null;
    }
  }
  return typeof candidate === "string" && existsSync(candidate) ? candidate : null;
}

// ISO 639-1 → ISO 639-2/B, the form the mp4 language field carries.
// The request's subtitle format → the ffmpeg demuxer that reads it.
const SUBTITLE_DEMUXERS = { vtt: "webvtt", srt: "srt", ass: "ass" };

const ISO_639_2 = {
  fr: "fre",
  en: "eng",
  ja: "jpn",
  es: "spa",
  de: "ger",
  it: "ita",
  pt: "por",
  ar: "ara",
  ru: "rus",
  zh: "chi",
  ko: "kor",
  nl: "dut",
  pl: "pol",
  tr: "tur",
};

function iso639_2(locale) {
  const primary = String(locale || "").split(/[-_]/)[0].toLowerCase();
  if (ISO_639_2[primary]) return ISO_639_2[primary];
  return /^[a-z]{3}$/.test(primary) ? primary : "und";
}

/**
 * input: { file, playlist: boolean }; audio: playlist file | null;
 * subtitles: [{ file, format, locale, label }]; language: "sub" | "dub" (the first
 * subtitle is the default track only for "sub"). Paths may be relative to
 * the cwd ffmpeg is spawned in.
 */
function buildRemuxArgs({ input, audio = null, subtitles = [], language, output }) {
  const local = ["-allowed_extensions", "ALL", "-protocol_whitelist", "file"];
  const args = ["-hide_banner", "-nostdin", "-nostats", "-y", "-progress", "pipe:1"];
  if (input.playlist) args.push(...local);
  args.push("-i", input.file);
  if (audio) args.push(...local, "-i", audio);
  const firstSubtitle = audio ? 2 : 1;
  // The page's text is read as the format it was declared, from that file
  // only: never sniffed into another demuxer or a protocol.
  for (const sub of subtitles) {
    args.push("-f", SUBTITLE_DEMUXERS[sub.format] || "webvtt", "-protocol_whitelist", "file", "-i", sub.file);
  }

  args.push("-map", "0:V?", "-map", audio ? "1:a:0" : "0:a?");
  subtitles.forEach((_, i) => args.push("-map", `${firstSubtitle + i}:s:0`));
  args.push("-c", "copy");
  if (subtitles.length) args.push("-c:s", "mov_text");
  subtitles.forEach((sub, i) => {
    args.push(
      `-metadata:s:s:${i}`,
      `language=${iso639_2(sub.locale)}`,
      `-metadata:s:s:${i}`,
      `title=${sub.label}`,
      // mp4 keeps a track's name in its handler box, not in "title"
      `-metadata:s:s:${i}`,
      `handler_name=${sub.label}`,
      `-disposition:s:${i}`,
      i === 0 && language === "sub" ? "default" : "0",
    );
  });
  args.push("-movflags", "+faststart", "-f", "mp4", output);
  return args;
}

/** Line parser for `-progress pipe:1`: calls onSeconds(out_time). */
function createProgressParser(onSeconds) {
  let pending = "";
  return (chunk) => {
    pending += chunk.toString("utf8");
    const lines = pending.split(/\r?\n/);
    pending = lines.pop();
    for (const line of lines) {
      const m = /^out_time_(?:us|ms)=(\d+)$/.exec(line.trim());
      if (m) onSeconds(Number(m[1]) / 1e6);
    }
  };
}

const DURATION_RE = /Duration: (\d+):(\d{2}):(\d{2}(?:\.\d+)?)/;

function parseDuration(stderr) {
  const m = DURATION_RE.exec(stderr);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
}

/**
 * Runs ffmpeg; resolves on exit 0. Aborting the signal kills the process.
 * onProgress(fraction 0–1) uses totalSeconds, or the input Duration ffmpeg
 * prints when it is not known.
 */
function runFfmpeg({
  ffmpegPath,
  args,
  cwd,
  signal,
  totalSeconds = null,
  onProgress,
  spawnImpl = spawn,
}) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) {
      return reject(new DownloadError("ffmpeg", "ffmpeg binary not found"));
    }
    if (signal?.aborted) return reject(signal.reason);

    let child;
    try {
      child = spawnImpl(ffmpegPath, args, {
        cwd,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      return reject(new DownloadError("ffmpeg", `spawn failed: ${err.code || err.message}`));
    }

    let total = totalSeconds;
    let stderr = "";
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      fn(value);
    };
    function onAbort() {
      try {
        child.kill("SIGKILL");
      } catch (_) {}
    }
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on(
      "data",
      createProgressParser((seconds) => {
        if (total > 0) onProgress?.(Math.min(1, Math.max(0, seconds / total)));
      }),
    );
    child.stderr?.on("data", (data) => {
      stderr = (stderr + data.toString("utf8")).slice(-8192);
      if (!total) total = parseDuration(stderr);
    });
    child.on("error", (err) => {
      finish(reject, new DownloadError("ffmpeg", `spawn failed: ${err.code || err.message}`));
    });
    child.on("close", (code, killSignal) => {
      if (signal?.aborted) return finish(reject, signal.reason);
      if (code === 0) return finish(resolve);
      const tail = stderr.trim().slice(-2000);
      finish(
        reject,
        new DownloadError("ffmpeg", `ffmpeg exited with ${code ?? killSignal}: ${tail}`),
      );
    });
  });
}

module.exports = {
  executableName,
  resolveFfmpegPath,
  iso639_2,
  buildRemuxArgs,
  createProgressParser,
  parseDuration,
  runFfmpeg,
};
