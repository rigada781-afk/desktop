// Whole pipeline without network or Electron: ffmpeg-static makes a tiny
// HLS stream, a fetch stub serves it (encrypted, byte ranges, separate
// audio), the job writes a real mp4 that ffmpeg then probes.
const { describe, test, expect, beforeAll, afterAll } = require("bun:test");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const { runJob, createPauseGate } = require("../downloads/job");
const { createHttp } = require("../downloads/http");
const { validateRequest } = require("../downloads/request");
const { resolveFfmpegPath } = require("../downloads/ffmpeg");
const { abortError } = require("../downloads/errors");

const ffmpeg = resolveFfmpegPath({ isPackaged: false });
const ORIGIN = "https://cdn.test";
const VTT = "WEBVTT\n\n00:00:01.000 --> 00:00:02.500\nBonjour !\n\n00:00:03.000 --> 00:00:04.000\nÇa marche.\n";

let root;
let media;

function run(args, cwd) {
  const out = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", ...args], { cwd, encoding: "utf8" });
  if (out.status !== 0) throw new Error(out.stderr);
}

function probe(file) {
  return spawnSync(ffmpeg, ["-hide_banner", "-i", file], { encoding: "utf8" }).stderr;
}

const lavfi = ["-f", "lavfi", "-i", "testsrc=size=160x90:rate=10", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100"];
const hlsOut = ["-t", "6", "-f", "hls", "-hls_time", "2", "-hls_playlist_type", "vod"];

beforeAll(() => {
  if (!ffmpeg) return;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "aniverse-job-"));
  media = path.join(root, "media");
  for (const dir of ["muxed", "video", "audio", "fmp4"]) fs.mkdirSync(path.join(media, dir), { recursive: true });
  const h264 = ["-c:v", "libx264", "-preset", "ultrafast", "-g", "10", "-pix_fmt", "yuv420p"];
  run([...lavfi, ...h264, "-c:a", "aac", "-b:a", "64k", ...hlsOut, "-hls_segment_filename", "s%d.ts", "index.m3u8"], path.join(media, "muxed"));
  run([...lavfi, "-map", "0:v", ...h264, ...hlsOut, "-hls_segment_filename", "v%d.ts", "index.m3u8"], path.join(media, "video"));
  run([...lavfi, "-map", "1:a", "-c:a", "aac", "-b:a", "64k", ...hlsOut, "-hls_segment_filename", "a%d.ts", "index.m3u8"], path.join(media, "audio"));
  run([...lavfi, ...h264, "-c:a", "aac", ...hlsOut, "-hls_segment_type", "fmp4", "-hls_flags", "single_file", "-hls_fmp4_init_filename", "init.mp4", "index.m3u8"], path.join(media, "fmp4"));
});

afterAll(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

// Serves `files` (url path → Buffer | string) with Range support.
function server(files, { delayMs = 0, log = [] } = {}) {
  return async (url, init) => {
    const { pathname } = new URL(url);
    log.push({ path: pathname, headers: { ...init.headers } });
    if (delayMs) {
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, delayMs);
        init.signal?.addEventListener("abort", () => {
          clearTimeout(t);
          reject(init.signal.reason);
        });
      });
    }
    const body = files[pathname];
    if (body == null) return new Response("<html>404</html>", { status: 404, headers: { "content-type": "text/html" } });
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
    const range = /bytes=(\d+)-(\d+)?/.exec(init.headers?.Range || "");
    if (range) {
      const start = Number(range[1]);
      const end = range[2] ? Number(range[2]) : buf.length - 1;
      return new Response(buf.subarray(start, end + 1), {
        status: 206,
        headers: { "content-range": `bytes ${start}-${end}/${buf.length}` },
      });
    }
    return new Response(buf, { status: 200 });
  };
}

function readDir(dir, prefix) {
  const files = {};
  for (const name of fs.readdirSync(dir)) files[`${prefix}/${name}`] = fs.readFileSync(path.join(dir, name));
  return files;
}

function encrypt(buf, key, iv) {
  const cipher = crypto.createCipheriv("aes-128-cbc", key, iv);
  return Buffer.concat([cipher.update(buf), cipher.final()]);
}

function request(source, extra = {}) {
  const result = validateRequest({
    source,
    headers: { Referer: "https://site.test/" },
    anime: { id: "a1", title: "Test" },
    episode: { number: 1 },
    language: "sub",
    watchPath: "/watch/test?ep=1",
    subtitles: [{ locale: "fr", label: "Français", format: "vtt", content: VTT, default: true }],
    ...extra,
  });
  if (!result.ok) throw new Error(result.reason);
  return result.request;
}

function jobContext(name, fetch, req, extra = {}) {
  const dir = path.join(root, name);
  const reports = [];
  return {
    reports,
    dir,
    ctx: {
      request: req,
      outputPath: path.join(dir, "out", "Test - Épisode 1 (VOSTFR).mp4"),
      tmpDir: path.join(dir, "tmp"),
      signal: new AbortController().signal,
      http: createHttp({ fetch, sleep: async () => {} }),
      ffmpegPath: ffmpeg,
      userAgent: "AniverseDesktop/test",
      report: (patch) => reports.push(patch),
      ...extra,
    },
  };
}

describe.skipIf(!ffmpeg)("runJob (real ffmpeg)", () => {
  test("AES-128 TS + separate audio rendition + French subtitles → one mp4", async () => {
    const key = crypto.randomBytes(16);
    const fixedIv = crypto.randomBytes(16);
    const files = { "/key.bin": key };
    // Video: first segment with an explicit IV, the others with the
    // sequence-number IV (MEDIA-SEQUENCE 5).
    const videoLines = fs.readFileSync(path.join(media, "video", "index.m3u8"), "utf8").split("\n");
    const out = [];
    let index = 0;
    for (const line of videoLines) {
      if (line.startsWith("#EXT-X-MEDIA-SEQUENCE")) {
        out.push("#EXT-X-MEDIA-SEQUENCE:5");
        continue;
      }
      if (line.startsWith("#EXTINF")) {
        if (index === 0) out.push(`#EXT-X-KEY:METHOD=AES-128,URI="/key.bin",IV=0x${fixedIv.toString("hex")}`);
        if (index === 1) out.push('#EXT-X-KEY:METHOD=AES-128,URI="../key.bin"');
      }
      if (line.endsWith(".ts")) {
        const plain = fs.readFileSync(path.join(media, "video", line));
        const iv = index === 0 ? fixedIv : (() => { const b = Buffer.alloc(16); b.writeBigUInt64BE(BigInt(5 + index), 8); return b; })();
        files[`/v/${line}`] = encrypt(plain, key, iv);
        index++;
      }
      out.push(line);
    }
    files["/v/index.m3u8"] = out.join("\n");
    Object.assign(files, readDir(path.join(media, "audio"), "/a"));
    files["/master.m3u8?token=1".split("?")[0]] = [
      "#EXTM3U",
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Japonais",LANGUAGE="ja",DEFAULT=YES,URI="/a/index.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=300000,RESOLUTION=160x90,AUDIO="aud"',
      "v/index.m3u8",
      '#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=1920x1080,AUDIO="aud"',
      "missing/index.m3u8",
    ].join("\n");

    const log = [];
    const { ctx, reports, dir } = jobContext("aes", server(files, { log }), request(`${ORIGIN}/master.m3u8?token=1`, { maxHeight: 360 }));
    const result = await runJob(ctx);

    expect(result.fileName).toBe("Test - Épisode 1 (VOSTFR).mp4");
    expect(result.sizeBytes).toBeGreaterThan(1000);
    const info = probe(result.outputPath);
    expect(info).toMatch(/Stream #0:\d+\S*: Video: h264/);
    expect(info).toMatch(/Stream #0:\d+\S*: Audio: aac/);
    expect(info).toMatch(/Stream #0:\d+(\[0x\w+\])?\(fre\): Subtitle: mov_text.*\(default\)/);
    expect(info).toMatch(/handler_name\s+: Français/);
    expect(info).toMatch(/Duration: 00:00:0[5-7]/);
    expect(fs.existsSync(ctx.tmpDir)).toBe(false);
    expect(fs.readdirSync(path.join(dir, "out"))).toEqual([result.fileName]);

    // Headers on every request, the app UA added, the key fetched once.
    expect(log.every((r) => r.headers.Referer === "https://site.test/" && r.headers["User-Agent"] === "AniverseDesktop/test")).toBe(true);
    expect(log.filter((r) => r.path === "/key.bin")).toHaveLength(1);
    expect(log.some((r) => r.path.startsWith("/missing"))).toBe(false);

    const merged = Object.assign({}, ...reports);
    expect(merged.quality).toBe("90p");
    const count = (dir) => (fs.readFileSync(path.join(media, dir, "index.m3u8"), "utf8").match(/\.ts$/gm) || []).length;
    expect(merged.segmentsTotal).toBe(count("video") + count("audio"));
    expect(merged.segmentsDone).toBe(merged.segmentsTotal);
    const phases = reports.filter((r) => r.phase).map((r) => r.phase);
    expect(phases).toEqual(["segments", "remux"]);
    const progress = reports.filter((r) => typeof r.progress === "number").map((r) => r.progress);
    expect(progress.every((p, i) => i === 0 || p >= progress[i - 1] - 1e-9)).toBe(true);
  }, 60_000);

  test("fMP4 with EXT-X-MAP and BYTERANGE segments, muxed audio, VF", async () => {
    const files = readDir(path.join(media, "fmp4"), "/f");
    const playlist = files["/f/index.m3u8"].toString();
    expect(playlist).toContain("#EXT-X-BYTERANGE");
    expect(playlist).toContain("#EXT-X-MAP");
    const log = [];
    const { ctx } = jobContext("fmp4", server(files, { log }), request(`${ORIGIN}/f/index.m3u8`, { language: "dub" }));
    const result = await runJob(ctx);
    const info = probe(result.outputPath);
    expect(info).toMatch(/Video: h264/);
    expect(info).toMatch(/Audio: aac/);
    expect(info).toMatch(/\(fre\): Subtitle: mov_text/);
    // VF: the subtitle track is not flagged default.
    expect(info).not.toMatch(/Subtitle: mov_text.*\(default\)/);
    expect(log.filter((r) => r.headers.Range).length).toBeGreaterThan(1);
  }, 60_000);

  test("pause holds the segment fetches, resume finishes the job", async () => {
    const files = readDir(path.join(media, "muxed"), "/m");
    const log = [];
    const gate = createPauseGate();
    const { ctx, reports } = jobContext("pause", server(files, { log, delayMs: 40 }), request(`${ORIGIN}/m/index.m3u8`, { subtitles: [] }), { gate });
    const pending = runJob(ctx);
    while (!reports.some((r) => r.segmentsDone >= 1)) await new Promise((r) => setTimeout(r, 5));
    gate.pause();
    const countAtPause = log.length;
    await new Promise((r) => setTimeout(r, 200));
    // In-flight requests were aborted; nothing new was asked while paused.
    expect(log.length).toBe(countAtPause);
    gate.resume();
    const result = await pending;
    expect(probe(result.outputPath)).toMatch(/Video: h264/);
  }, 60_000);

  test("cancel aborts, removes the temp dir and the part file", async () => {
    const files = readDir(path.join(media, "muxed"), "/m");
    const controller = new AbortController();
    const { ctx, reports, dir } = jobContext("cancel", server(files, { delayMs: 30 }), request(`${ORIGIN}/m/index.m3u8`), { signal: controller.signal });
    const pending = runJob(ctx);
    while (!reports.some((r) => r.segmentsDone >= 1)) await new Promise((r) => setTimeout(r, 5));
    controller.abort(abortError("cancel"));
    const err = await pending.catch((e) => e);
    expect(err.kind).toBe("cancel");
    expect(fs.existsSync(ctx.tmpDir)).toBe(false);
    expect(fs.readdirSync(path.join(dir, "out"))).toEqual([]);
  }, 60_000);

  test("a 403 segment ends in 'forbidden', no file left", async () => {
    const files = readDir(path.join(media, "muxed"), "/m");
    delete files["/m/s2.ts"];
    const fetch = server(files);
    const deny = async (url, init) =>
      url.endsWith("/m/s2.ts") ? new Response("<html>nginx</html>", { status: 403, headers: { "content-type": "text/html" } }) : fetch(url, init);
    const { ctx, dir } = jobContext("forbidden", deny, request(`${ORIGIN}/m/index.m3u8`));
    const err = await runJob(ctx).catch((e) => e);
    expect(err.code).toBe("forbidden");
    expect(fs.existsSync(ctx.tmpDir)).toBe(false);
    expect(fs.readdirSync(path.join(dir, "out"))).toEqual([]);
  }, 60_000);

  test("without ffmpeg an HLS job fails at once, before any download", async () => {
    const calls = [];
    const fetch = async (url) => {
      calls.push(url);
      return new Response("", { status: 404 });
    };
    const { ctx } = jobContext("no-ffmpeg", fetch, request(`${ORIGIN}/m/index.m3u8`), { ffmpegPath: null });
    const err = await runJob(ctx).catch((e) => e);
    expect(err.code).toBe("ffmpeg");
    expect(calls).toEqual([]);
  });

  test("a live playlist (no ENDLIST) is unsupported", async () => {
    const files = readDir(path.join(media, "muxed"), "/m");
    files["/m/index.m3u8"] = files["/m/index.m3u8"].toString().replace("#EXT-X-ENDLIST", "");
    const { ctx } = jobContext("live", server(files), request(`${ORIGIN}/m/index.m3u8`));
    const err = await runJob(ctx).catch((e) => e);
    expect(err.code).toBe("unsupported");
  }, 30_000);

  test("kind mp4: ranged direct download, subtitles added by a remux", async () => {
    const mp4 = path.join(root, "direct.mp4");
    run([...lavfi, "-t", "3", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", mp4], root);
    const files = { "/film.mp4": fs.readFileSync(mp4) };
    const { ctx } = jobContext("direct", server(files), request(`${ORIGIN}/film.mp4`));
    expect(ctx.request.kind).toBe("mp4");
    const result = await runJob(ctx);
    const info = probe(result.outputPath);
    expect(info).toMatch(/Video: h264/);
    expect(info).toMatch(/\(fre\): Subtitle: mov_text/);

    // Without subtitles: a plain move of the downloaded file.
    const plain = jobContext("direct-plain", server(files), request(`${ORIGIN}/film.mp4`, { subtitles: [] }));
    const moved = await runJob(plain.ctx);
    expect(fs.readFileSync(moved.outputPath).equals(files["/film.mp4"])).toBe(true);
  }, 60_000);
});
