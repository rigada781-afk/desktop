const { describe, test, expect } = require("bun:test");
const {
  buildRecord,
  reconcileRecords,
  roundProgress,
  sortNewestFirst,
  storable,
  isSameEpisode,
} = require("../downloads/records");
const { validateRequest } = require("../downloads/request");

const { request } = validateRequest({
  source: "https://cdn.example/v1/stream/x/master.m3u8?token=secret",
  headers: { Authorization: "Bearer secret-jwt" },
  maxHeight: 1080,
  anime: { id: "anime-1", title: "Frieren", slug: "frieren", image: "https://img/p.webp" },
  episode: { number: 3, title: null, image: "https://img/e3.webp" },
  language: "dub",
  watchPath: "/watch/frieren?ep=3&lang=dub",
  subtitles: [{ locale: "fr", label: "Français", format: "vtt", content: "WEBVTT\n\nsecret", default: true }],
});

describe("buildRecord", () => {
  const record = buildRecord({
    id: "id-1",
    request,
    fileName: "Frieren - Épisode 3 (VF).mp4",
    outputPath: "C:\\Users\\u\\Downloads\\Aniverse\\Frieren - Épisode 3 (VF).mp4",
    now: 1000,
  });

  test("exactly the contract's fields", () => {
    expect(record).toEqual({
      id: "id-1",
      status: "queued",
      phase: null,
      progress: 0,
      mediaType: "anime",
      anime: { id: "anime-1", title: "Frieren", slug: "frieren", image: "https://img/p.webp", isMovie: false },
      episode: { number: 3, title: null, image: "https://img/e3.webp" },
      language: "dub",
      watchPath: "/watch/frieren?ep=3&lang=dub",
      quality: null,
      subtitles: [{ locale: "fr", label: "Français" }],
      fileName: "Frieren - Épisode 3 (VF).mp4",
      outputPath: "C:\\Users\\u\\Downloads\\Aniverse\\Frieren - Épisode 3 (VF).mp4",
      createdAt: 1000,
    });
  });

  test("every episode download is an anime record (chapters will be manga)", () => {
    expect(record.mediaType).toBe("anime");
    const film = validateRequest({ ...request, anime: { ...request.anime, isMovie: true } }).request;
    expect(buildRecord({ id: "id-3", request: film, fileName: "f.mp4", outputPath: "C:\\f.mp4", now: 1 }).mediaType).toBe("anime");
  });

  test("a film is marked, so the site can say Film instead of Épisode 1", () => {
    const film = validateRequest({ ...request, anime: { ...request.anime, isMovie: true } }).request;
    expect(buildRecord({ id: "id-2", request: film, fileName: "f.mp4", outputPath: "C:\\f.mp4", now: 1 }).anime.isMovie).toBe(true);
  });

  test("no headers, token, source URL or subtitle text", () => {
    const json = JSON.stringify(record);
    expect(json).not.toContain("secret");
    expect(json).not.toContain("cdn.example");
    expect(json).not.toContain("WEBVTT");
  });

  test("same episode = anime id + episode number + language", () => {
    expect(isSameEpisode(record, request)).toBe(true);
    expect(isSameEpisode(record, { ...request, language: "sub" })).toBe(false);
    expect(isSameEpisode(record, { ...request, episode: { number: 4 } })).toBe(false);
  });
});

describe("helpers", () => {
  test("progress rounded to 0.1 and clamped", () => {
    expect(roundProgress(12.345)).toBe(12.3);
    expect(roundProgress(99.96)).toBe(100);
    expect(roundProgress(-3)).toBe(0);
    expect(roundProgress(140)).toBe(100);
    expect(roundProgress(Number.NaN)).toBe(0);
  });

  test("newest first, legacy records by startedAt", () => {
    const sorted = sortNewestFirst([
      { id: "a", createdAt: 1 },
      { id: "legacy", startedAt: 5 },
      { id: "c", createdAt: 3 },
    ]);
    expect(sorted.map((r) => r.id)).toEqual(["legacy", "c", "a"]);
  });

  test("storable drops undefined values and fileExists", () => {
    expect(storable({ id: "a", speedBps: undefined, fileExists: true })).toEqual({ id: "a" });
  });
});

describe("startup reconciliation", () => {
  test("queued / downloading / paused become interrupted, the rest is untouched", () => {
    const legacy = { id: "old", fileName: "x.mp4", masterUrl: "https://x", status: "completed", statusText: "Done" };
    const stuckLegacy = { id: "old2", fileName: "y.mp4", status: "downloading", statusText: "Downloading…" };
    const input = [
      { id: "q", status: "queued", phase: null },
      { id: "d", status: "downloading", phase: "segments", speedBps: 1000, progress: 40 },
      { id: "p", status: "paused", phase: "segments", progress: 10 },
      { id: "c", status: "completed", progress: 100 },
      { id: "e", status: "error", error: { code: "network", message: "x" } },
      legacy,
      stuckLegacy,
    ];
    const { records, interrupted } = reconcileRecords(input, 5000);
    expect(interrupted.map((r) => r.id)).toEqual(["q", "d", "p", "old2"]);
    const byId = Object.fromEntries(records.map((r) => [r.id, r]));
    expect(byId.d).toEqual({
      id: "d",
      status: "interrupted",
      phase: null,
      progress: 40,
      error: { code: "interrupted", message: "" },
      finishedAt: 5000,
    });
    expect(byId.c).toBe(input[3]);
    expect(byId.e).toBe(input[4]);
    expect(byId.old).toBe(legacy);
    expect(byId.old2.fileName).toBe("y.mp4");
  });
});
