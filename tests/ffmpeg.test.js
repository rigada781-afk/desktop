const { describe, test, expect } = require("bun:test");
const path = require("path");
const { EventEmitter } = require("events");
const {
  buildRemuxArgs,
  createProgressParser,
  iso639_2,
  parseDuration,
  resolveFfmpegPath,
  runFfmpeg,
} = require("../downloads/ffmpeg");
const { abortError } = require("../downloads/errors");

describe("resolveFfmpegPath", () => {
  test("packaged: resources/ffmpeg/ffmpeg(.exe)", () => {
    const exists = () => true;
    expect(
      resolveFfmpegPath({ isPackaged: true, resourcesPath: "/app/resources", platform: "win32", existsSync: exists }),
    ).toBe(path.join("/app/resources", "ffmpeg", "ffmpeg.exe"));
    expect(
      resolveFfmpegPath({ isPackaged: true, resourcesPath: "/app/resources", platform: "darwin", existsSync: exists }),
    ).toBe(path.join("/app/resources", "ffmpeg", "ffmpeg"));
  });

  test("dev: ffmpeg-static; missing binary → null", () => {
    expect(
      resolveFfmpegPath({ isPackaged: false, requireStatic: () => "/n/ffmpeg", existsSync: () => true }),
    ).toBe("/n/ffmpeg");
    expect(
      resolveFfmpegPath({ isPackaged: false, requireStatic: () => "/n/ffmpeg", existsSync: () => false }),
    ).toBeNull();
    expect(
      resolveFfmpegPath({
        isPackaged: false,
        requireStatic: () => {
          throw new Error("MODULE_NOT_FOUND");
        },
      }),
    ).toBeNull();
    // The real dev binary is installed.
    expect(resolveFfmpegPath({ isPackaged: false })).toMatch(/ffmpeg(\.exe)?$/);
  });
});

describe("buildRemuxArgs", () => {
  const subs = [
    { file: "subs/0.vtt", format: "vtt", locale: "fr", label: "Français" },
    { file: "subs/1.srt", format: "srt", locale: "en-US", label: "English" },
  ];

  test("HLS + separate audio + subtitles, VOSTFR: first subtitle is default", () => {
    const args = buildRemuxArgs({
      input: { file: "video.m3u8", playlist: true },
      audio: "audio.m3u8",
      subtitles: subs,
      language: "sub",
      output: "D:\\Out\\A.part.mp4",
    });
    expect(args.join(" ")).toBe(
      [
        "-hide_banner -nostdin -nostats -y -progress pipe:1",
        "-allowed_extensions ALL -protocol_whitelist file -i video.m3u8",
        "-allowed_extensions ALL -protocol_whitelist file -i audio.m3u8",
        // Each subtitle read as its declared format, from that file only
        "-f webvtt -protocol_whitelist file -i subs/0.vtt -f srt -protocol_whitelist file -i subs/1.srt",
        "-map 0:V? -map 1:a:0 -map 2:s:0 -map 3:s:0",
        "-c copy -c:s mov_text",
        "-metadata:s:s:0 language=fre -metadata:s:s:0 title=Français -metadata:s:s:0 handler_name=Français -disposition:s:0 default",
        "-metadata:s:s:1 language=eng -metadata:s:s:1 title=English -metadata:s:s:1 handler_name=English -disposition:s:1 0",
        "-movflags +faststart -f mp4 D:\\Out\\A.part.mp4",
      ].join(" "),
    );
  });

  test("VF: no default subtitle; muxed audio; no subtitles → no mov_text", () => {
    const vf = buildRemuxArgs({
      input: { file: "video.m3u8", playlist: true },
      subtitles: subs.slice(0, 1),
      language: "dub",
      output: "o.mp4",
    });
    expect(vf).toContain("0:a?");
    expect(vf[vf.indexOf("-disposition:s:0") + 1]).toBe("0");
    const plain = buildRemuxArgs({ input: { file: "source.mp4", playlist: false }, language: "sub", output: "o.mp4" });
    expect(plain).not.toContain("mov_text");
    expect(plain).not.toContain("-allowed_extensions");
  });

  test("ISO 639-2 codes", () => {
    expect(iso639_2("fr")).toBe("fre");
    expect(iso639_2("fr-FR")).toBe("fre");
    expect(iso639_2("ja")).toBe("jpn");
    expect(iso639_2("fre")).toBe("fre");
    expect(iso639_2("xx")).toBe("und");
  });
});

describe("progress", () => {
  test("out_time_us lines, split across chunks", () => {
    const seen = [];
    const parse = createProgressParser((s) => seen.push(s));
    parse(Buffer.from("frame=10\nout_time_us=1500"));
    parse(Buffer.from("000\nout_time_ms=3000000\r\nprogress=continue\n"));
    expect(seen).toEqual([1.5, 3]);
  });

  test("Duration from stderr", () => {
    expect(parseDuration("Input #0, mov\n  Duration: 00:24:01.52, start: 0")).toBeCloseTo(1441.52, 2);
    expect(parseDuration("nothing")).toBeNull();
  });
});

describe("runFfmpeg", () => {
  function fakeSpawn(behaviour) {
    const calls = [];
    const spawnImpl = (cmd, args, opts) => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.killed = false;
      child.kill = () => {
        child.killed = true;
        setTimeout(() => child.emit("close", null, "SIGKILL"), 1);
      };
      calls.push({ cmd, args, opts, child });
      setTimeout(() => behaviour(child), 1);
      return child;
    };
    return { spawnImpl, calls };
  }

  test("progress, windowsHide, exit 0", async () => {
    const { spawnImpl, calls } = fakeSpawn((child) => {
      child.stdout.emit("data", Buffer.from("out_time_us=5000000\n"));
      child.emit("close", 0);
    });
    const fractions = [];
    await runFfmpeg({ ffmpegPath: "ffmpeg", args: ["-i", "x"], cwd: "/tmp", totalSeconds: 10, onProgress: (f) => fractions.push(f), spawnImpl });
    expect(fractions).toEqual([0.5]);
    expect(calls[0].opts.windowsHide).toBe(true);
    expect(calls[0].opts.cwd).toBe("/tmp");
  });

  test("non-zero exit → 'ffmpeg' error with the stderr tail", async () => {
    const { spawnImpl } = fakeSpawn((child) => {
      child.stderr.emit("data", Buffer.from("x".repeat(5000) + "\nInvalid data found when processing input\n"));
      child.emit("close", 1);
    });
    const err = await runFfmpeg({ ffmpegPath: "ffmpeg", args: [], spawnImpl }).catch((e) => e);
    expect(err.code).toBe("ffmpeg");
    expect(err.message).toContain("Invalid data found");
    expect(err.message.length).toBeLessThan(2100);
  });

  test("abort kills the process", async () => {
    const controller = new AbortController();
    const { spawnImpl, calls } = fakeSpawn(() => controller.abort(abortError("cancel")));
    const err = await runFfmpeg({ ffmpegPath: "ffmpeg", args: [], signal: controller.signal, spawnImpl }).catch((e) => e);
    expect(err.kind).toBe("cancel");
    expect(calls[0].child.killed).toBe(true);
  });

  test("missing binary → 'ffmpeg' error", async () => {
    const err = await runFfmpeg({ ffmpegPath: null, args: [] }).catch((e) => e);
    expect(err.code).toBe("ffmpeg");
  });
});
