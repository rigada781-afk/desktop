const { describe, test, expect } = require("bun:test");
const { validateRequest, MAX_SUBTITLE_BYTES } = require("../downloads/request");

function baseRequest(overrides = {}) {
  return {
    source: "https://hls.example/p/abc/master.m3u8",
    headers: { Origin: "https://zokoanime.video", Referer: "https://zokoanime.video/" },
    anime: { id: "ba096853-415d-46df-aa87-ee4787832bc0", title: "Frieren", slug: "frieren" },
    episode: { number: 1, title: "La fin du voyage" },
    language: "sub",
    watchPath: "/watch/frieren?ep=1&lang=sub",
    subtitles: [{ locale: "fr", label: "Français", format: "vtt", content: "WEBVTT\n", default: true }],
    ...overrides,
  };
}

const reason = (req) => validateRequest(req).reason;

describe("validateRequest", () => {
  test("a valid request is normalized into a fresh object", () => {
    const result = validateRequest({ ...baseRequest(), outputDir: "C:\\Windows", extra: 1 });
    expect(result.ok).toBe(true);
    expect(result.request).toEqual({
      source: "https://hls.example/p/abc/master.m3u8",
      kind: "hls",
      headers: { Origin: "https://zokoanime.video", Referer: "https://zokoanime.video/" },
      maxHeight: null,
      anime: {
        id: "ba096853-415d-46df-aa87-ee4787832bc0",
        title: "Frieren",
        slug: "frieren",
        image: null,
        isMovie: false,
      },
      episode: { number: 1, title: "La fin du voyage", image: null },
      language: "sub",
      watchPath: "/watch/frieren?ep=1&lang=sub",
      subtitles: [
        { locale: "fr", label: "Français", format: "vtt", content: "WEBVTT\n", default: true },
      ],
    });
    expect("outputDir" in result.request).toBe(false);
  });

  test("source: http(s) only", () => {
    expect(reason(baseRequest({ source: "file:///C:/x.m3u8" }))).toBe("source");
    expect(reason(baseRequest({ source: "javascript:alert(1)" }))).toBe("source");
    expect(reason(baseRequest({ source: "/api/proxy/v2/x.m3u8" }))).toBe("source");
    expect(reason(baseRequest({ source: 42 }))).toBe("source");
  });

  test("kind: given, or mp4 from the URL path", () => {
    expect(validateRequest(baseRequest({ source: "https://x/a/film.MP4?t=1" })).request.kind).toBe("mp4");
    expect(validateRequest(baseRequest({ source: "https://x/a/film.m4v" })).request.kind).toBe("mp4");
    expect(validateRequest(baseRequest({ kind: "hls", source: "https://x/a.mp4" })).request.kind).toBe("hls");
    expect(reason(baseRequest({ kind: "dash" }))).toBe("kind");
  });

  test("the signed source URL is kept byte for byte", () => {
    const source = "https://prx.vmget.online/hls2/01/k_,n,l,.urlset/master.m3u8?t=Hc+Dg/x=&s=1&v=&asn=1";
    expect(validateRequest(baseRequest({ source })).request.source).toBe(source);
  });

  test("headers: CR/LF refused, transport headers dropped", () => {
    expect(reason(baseRequest({ headers: { Referer: "a\r\nX-Evil: 1" } }))).toBe("headers");
    expect(reason(baseRequest({ headers: { "Bad Name": "x" } }))).toBe("headers");
    expect(reason(baseRequest({ headers: { Referer: 1 } }))).toBe("headers");
    expect(reason(baseRequest({ headers: "Referer: x" }))).toBe("headers");
    const { request } = validateRequest(
      baseRequest({ headers: { Host: "x", Range: "bytes=0-", Authorization: "Bearer t" } }),
    );
    expect(request.headers).toEqual({ Authorization: "Bearer t" });
  });

  test("titles at most 300 characters", () => {
    expect(validateRequest(baseRequest({ anime: { id: "a", title: "t".repeat(300) } })).ok).toBe(true);
    expect(reason(baseRequest({ anime: { id: "a", title: "t".repeat(301) } }))).toBe("anime");
    expect(reason(baseRequest({ anime: { id: "a", title: "  " } }))).toBe("anime");
    expect(reason(baseRequest({ episode: { number: 1, title: "t".repeat(301) } }))).toBe("episode");
  });

  test("episode number, language, maxHeight, watchPath", () => {
    expect(reason(baseRequest({ episode: { number: -1 } }))).toBe("episode");
    expect(reason(baseRequest({ episode: { number: "1" } }))).toBe("episode");
    expect(reason(baseRequest({ episode: { number: Number.NaN } }))).toBe("episode");
    expect(reason(baseRequest({ language: "vf" }))).toBe("language");
    expect(reason(baseRequest({ maxHeight: 0 }))).toBe("maxHeight");
    expect(reason(baseRequest({ maxHeight: 720.5 }))).toBe("maxHeight");
    expect(validateRequest(baseRequest({ maxHeight: 720 })).request.maxHeight).toBe(720);
    expect(reason(baseRequest({ watchPath: "https://evil/x" }))).toBe("watchPath");
    expect(reason(baseRequest({ watchPath: "//evil/x" }))).toBe("watchPath");
  });

  test("images: http(s) kept, anything else dropped", () => {
    const { request } = validateRequest(
      baseRequest({
        anime: { id: "a", title: "T", image: "https://img/x.webp" },
        episode: { number: 2, image: "javascript:1" },
      }),
    );
    expect(request.anime.image).toBe("https://img/x.webp");
    expect(request.episode.image).toBeNull();
  });

  test("subtitles: at most 8, 5 MB each, known formats, default first", () => {
    const sub = (i, extra = {}) => ({ locale: "fr", label: `S${i}`, format: "vtt", content: "WEBVTT", ...extra });
    expect(validateRequest(baseRequest({ subtitles: Array.from({ length: 8 }, (_, i) => sub(i)) })).ok).toBe(true);
    expect(reason(baseRequest({ subtitles: Array.from({ length: 9 }, (_, i) => sub(i)) }))).toBe("subtitles");
    expect(reason(baseRequest({ subtitles: [sub(0, { content: "x".repeat(MAX_SUBTITLE_BYTES + 1) })] }))).toBe("subtitles");
    expect(reason(baseRequest({ subtitles: [sub(0, { format: "pgs" })] }))).toBe("subtitles");
    expect(reason(baseRequest({ subtitles: [sub(0, { locale: "../x" })] }))).toBe("subtitles");
    // Text that isn't the subtitle it claims to be is left out; the episode still downloads
    for (const bad of [
      { content: "" },
      { content: "<!DOCTYPE html><title>403</title>" },
      { format: "srt", content: "WEBVTT\n\n00:01.000 --> 00:02.000\nx" },
      { format: "ass", content: "1\n00:00:01,000 --> 00:00:02,000\nx" },
    ]) {
      const result = validateRequest(baseRequest({ subtitles: [sub(0, bad), sub(1)] }));
      expect(result.ok).toBe(true);
      expect(result.request.subtitles.map((s) => s.label)).toEqual(["S1"]);
    }
    const formats = validateRequest(
      baseRequest({
        subtitles: [
          sub(0, { content: "﻿WEBVTT\n\n00:01.000 --> 00:02.000\nx" }),
          sub(1, { format: "srt", content: "1\r\n00:00:01,000 --> 00:00:02,000\r\nx" }),
          sub(2, { format: "ass", content: "[Script Info]\nTitle: x" }),
        ],
      }),
    );
    expect(formats.request.subtitles.map((s) => s.format)).toEqual(["vtt", "srt", "ass"]);
    const { request } = validateRequest(
      baseRequest({ subtitles: [sub(0, { locale: "en" }), sub(1, { default: true })] }),
    );
    expect(request.subtitles.map((s) => s.label)).toEqual(["S1", "S0"]);
    expect(validateRequest(baseRequest({ subtitles: undefined })).request.subtitles).toEqual([]);
  });

  test("non-objects", () => {
    expect(reason(null)).toBe("request");
    expect(reason("x")).toBe("request");
    expect(reason([])).toBe("request");
    expect(reason(baseRequest({ anime: null }))).toBe("anime");
  });
});
