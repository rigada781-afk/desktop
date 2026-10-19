const { describe, test, expect, beforeEach, afterEach } = require("bun:test");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  createMediaServer,
  parseRange,
  parseMediaUrl,
  videoUrl,
  subtitleUrl,
  imageUrl,
} = require("../downloads/media");

const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

describe("parseRange", () => {
  test("open, closed and suffix ranges", () => {
    expect(parseRange("bytes=0-", 100)).toEqual({ start: 0, end: 99 });
    expect(parseRange("bytes=10-19", 100)).toEqual({ start: 10, end: 19 });
    expect(parseRange("bytes=90-500", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=-500", 100)).toEqual({ start: 0, end: 99 });
  });

  test("no usable range: the whole file", () => {
    expect(parseRange(null, 100)).toBeNull();
    expect(parseRange("bytes=-", 100)).toBeNull();
    expect(parseRange("items=0-1", 100)).toBeNull();
    expect(parseRange("bytes=0-1,5-6", 100)).toBeNull();
  });

  test("past the end", () => {
    expect(parseRange("bytes=100-", 100)).toBe("unsatisfiable");
    expect(parseRange("bytes=20-10", 100)).toBe("unsatisfiable");
    expect(parseRange("bytes=-0", 100)).toBe("unsatisfiable");
  });
});

describe("parseMediaUrl", () => {
  test("the three kinds", () => {
    expect(parseMediaUrl(videoUrl(ID))).toEqual({ kind: "video", id: ID });
    expect(parseMediaUrl(subtitleUrl(ID, 2))).toEqual({ kind: "subtitle", id: ID, index: 2 });
    expect(parseMediaUrl(imageUrl(ID, "episode"))).toEqual({ kind: "image", id: ID, image: "episode" });
    // The site's proxy builder may add a query: ignored
    expect(parseMediaUrl(`${videoUrl(ID)}?aniverse-headers=%7B%7D`)).toEqual({ kind: "video", id: ID });
  });

  test("anything else is refused", () => {
    expect(parseMediaUrl("https://aniverse.fr/video/" + ID)).toBeNull();
    expect(parseMediaUrl("aniverse-media://video/../../etc/passwd")).toBeNull();
    expect(parseMediaUrl("aniverse-media://video/not-an-id")).toBeNull();
    expect(parseMediaUrl(`aniverse-media://video/${ID}/x`)).toBeNull();
    expect(parseMediaUrl(`aniverse-media://subtitle/${ID}/abc`)).toBeNull();
    expect(parseMediaUrl(`aniverse-media://image/${ID}/banner`)).toBeNull();
    expect(parseMediaUrl(`aniverse-media://file/${ID}`)).toBeNull();
    expect(parseMediaUrl("not a url")).toBeNull();
  });
});

describe("createMediaServer", () => {
  let dir;
  let file;
  let records;
  let media;
  const request = (url, headers = {}) => new Request(url, { headers });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aniverse-media-"));
    file = path.join(dir, "Frieren - Épisode 1 (VOSTFR).mp4");
    fs.writeFileSync(file, Buffer.from("0123456789abcdefghij"));
    records = new Map([
      [
        ID,
        {
          id: ID,
          status: "completed",
          outputPath: file,
          language: "sub",
          anime: { id: "a", title: "Frieren", image: "https://cdn.example/a.jpg" },
          episode: { number: 1, title: null, image: null },
          subtitles: [
            { locale: "fr", label: "Français" },
            { locale: "en", label: "English" },
          ],
        },
      ],
    ]);
    media = createMediaServer({
      getRecord: (id) => records.get(id) ?? null,
      root: path.join(dir, "media"),
      ffmpegPath: () => null,
      appOrigin: "https://aniverse.fr",
      fetchImpl: async () =>
        new Response(Buffer.from([0xff, 0xd8, 0xff]), { headers: { "content-type": "image/jpeg" } }),
    });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("playback: the video and its tracks, the first one default for VOSTFR", () => {
    expect(media.playback(ID)).toEqual({
      id: ID,
      video: videoUrl(ID),
      subtitles: [
        { url: subtitleUrl(ID, 0), locale: "fr", label: "Français", default: true },
        { url: subtitleUrl(ID, 1), locale: "en", label: "English", default: false },
      ],
    });
    records.get(ID).language = "dub";
    expect(media.playback(ID).subtitles.every((s) => !s.default)).toBe(true);
  });

  test("playback: null when not completed, gone from the disk, or unknown", () => {
    expect(media.playback("nope")).toBeNull();
    records.get(ID).status = "downloading";
    expect(media.playback(ID)).toBeNull();
    records.get(ID).status = "completed";
    fs.rmSync(file);
    expect(media.playback(ID)).toBeNull();
  });

  test("video: whole file, then a byte range", async () => {
    const whole = await media.handle(request(videoUrl(ID)));
    expect(whole.status).toBe(200);
    expect(whole.headers.get("accept-ranges")).toBe("bytes");
    expect(whole.headers.get("access-control-allow-origin")).toBe("https://aniverse.fr");
    expect(await whole.text()).toBe("0123456789abcdefghij");

    const part = await media.handle(request(videoUrl(ID), { range: "bytes=10-14" }));
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 10-14/20");
    expect(part.headers.get("content-length")).toBe("5");
    expect(await part.text()).toBe("abcde");

    const past = await media.handle(request(videoUrl(ID), { range: "bytes=30-" }));
    expect(past.status).toBe(416);
  });

  test("subtitles: the kept original text, with its type", async () => {
    media.saveSidecars(records.get(ID), {
      subtitles: [
        { format: "ass", content: "[Script Info]\nTitle: x\n" },
        { format: "vtt", content: "WEBVTT\n\n00:00.000 --> 00:01.000\nSalut\n" },
      ],
    });
    const ass = await media.handle(request(subtitleUrl(ID, 0)));
    expect(ass.status).toBe(200);
    expect(ass.headers.get("content-type")).toBe("text/ass; charset=utf-8");
    expect(await ass.text()).toContain("[Script Info]");
    const vtt = await media.handle(request(subtitleUrl(ID, 1)));
    expect(vtt.headers.get("content-type")).toBe("text/vtt; charset=utf-8");
  });

  test("subtitles: without a sidecar nor ffmpeg, a 404", async () => {
    expect((await media.handle(request(subtitleUrl(ID, 0)))).status).toBe(404);
    expect((await media.handle(request(subtitleUrl(ID, 5)))).status).toBe(404);
  });

  test("images: fetched once, then from the disk", async () => {
    let fetches = 0;
    const counting = createMediaServer({
      getRecord: (id) => records.get(id) ?? null,
      root: path.join(dir, "media"),
      fetchImpl: async () => {
        fetches++;
        return new Response(Buffer.from([0x89, 0x50]), { headers: { "content-type": "image/png" } });
      },
    });
    const first = await counting.handle(request(imageUrl(ID, "anime")));
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toBe("image/png");
    await counting.handle(request(imageUrl(ID, "anime")));
    expect(fetches).toBe(1);
    // No episode image in the record
    expect((await counting.handle(request(imageUrl(ID, "episode")))).status).toBe(404);
  });

  test("images: a response that isn't an image is not kept", async () => {
    const html = createMediaServer({
      getRecord: (id) => records.get(id) ?? null,
      root: path.join(dir, "media"),
      fetchImpl: async () => new Response("<html>", { headers: { "content-type": "text/html" } }),
    });
    expect((await html.handle(request(imageUrl(ID, "anime")))).status).toBe(404);
  });

  test("forget: the record's kept files go", async () => {
    media.saveSidecars(records.get(ID), { subtitles: [{ format: "vtt", content: "WEBVTT\n" }] });
    await media.handle(request(imageUrl(ID, "anime")));
    expect(fs.existsSync(path.join(dir, "media", ID))).toBe(true);
    media.forget(ID);
    expect(fs.existsSync(path.join(dir, "media", ID))).toBe(false);
    // The video itself is the user's file: never touched
    expect(fs.existsSync(file)).toBe(true);
  });

  test("other methods and unknown links: 404", async () => {
    expect((await media.handle(new Request(videoUrl(ID), { method: "POST", body: "x" }))).status).toBe(404);
    expect((await media.handle(request("aniverse-media://video/nope"))).status).toBe(404);
  });
});
