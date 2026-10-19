const { describe, test, expect, beforeEach, afterEach } = require("bun:test");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createDownloadManager } = require("../downloads/manager");
const { createChapterSaver, validateChapterRequest, chapterFileName } = require("../downloads/chapters");
const { createMediaServer, chapterUrl } = require("../downloads/media");

const avm = (extra = "") => new Uint8Array(Buffer.from(`AVM1\u0001....{"header":1}${extra}`, "latin1"));
const request = (overrides = {}) => ({
  manga: { id: "m-1", title: "Chainsaw Man: Part 2", slug: "chainsaw-man", image: "https://cdn.example/c.webp" },
  chapter: { id: "c-12", number: "12", title: "Le goût", kind: "chapter" },
  pageCount: 20,
  bytes: avm(),
  ...overrides,
});

describe("validateChapterRequest", () => {
  test("a good request is copied", () => {
    const parsed = validateChapterRequest(request());
    expect(parsed.ok).toBe(true);
    expect(parsed.request.manga).toEqual({ id: "m-1", title: "Chainsaw Man: Part 2", slug: "chainsaw-man", image: "https://cdn.example/c.webp" });
    expect(Buffer.isBuffer(parsed.request.bytes)).toBe(true);
  });

  test("refused: not an .avm file, bad numbers, paths, missing fields", () => {
    expect(validateChapterRequest(request({ bytes: new Uint8Array(Buffer.from("PK\u0003\u0004 zip file")) })).ok).toBe(false);
    expect(validateChapterRequest(request({ chapter: { id: "c", number: "../12", kind: "chapter" } })).ok).toBe(false);
    expect(validateChapterRequest(request({ chapter: { id: "c", number: "12", kind: "volume" } })).ok).toBe(false);
    expect(validateChapterRequest(request({ manga: { id: "m", title: "x", slug: "../../etc" } })).ok).toBe(false);
    expect(validateChapterRequest(request({ manga: { id: "m" } })).ok).toBe(false);
    expect(validateChapterRequest(request({ pageCount: 0 })).ok).toBe(false);
    expect(validateChapterRequest(request({ bytes: "AVM1...." })).ok).toBe(false);
    expect(validateChapterRequest(null).ok).toBe(false);
  });

  test("a non-http image is dropped, the chapter still saves", () => {
    const parsed = validateChapterRequest(request({ manga: { id: "m", title: "x", image: "javascript:alert(1)" } }));
    expect(parsed.ok).toBe(true);
    expect(parsed.request.manga.image).toBeNull();
  });
});

describe("chapterFileName", () => {
  test("<slug>-chapter-<n>.avm, tomes too", () => {
    expect(chapterFileName(request())).toBe("chainsaw-man-chapter-12.avm");
    expect(chapterFileName({ manga: { title: "One Piece" }, chapter: { kind: "tome", number: "3" } })).toBe("one-piece-tome-3.avm");
    expect(chapterFileName({ manga: { title: "Re:Zéro" }, chapter: { kind: "chapter", number: "12.5" } })).toBe("re-zero-chapter-12-5.avm");
  });
});

describe("createChapterSaver", () => {
  let dir;
  let manager;
  let saver;
  let sent;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aniverse-chapters-"));
    const memory = new Map();
    sent = [];
    manager = createDownloadManager({
      store: { get: (k) => memory.get(k), set: (k, v) => memory.set(k, v) },
      send: (channel, payload) => sent.push([channel, payload]),
      tmpRoot: path.join(dir, "tmp"),
      getFolder: () => path.join(dir, "Aniverse"),
    });
    manager.init();
    saver = createChapterSaver({ manager, getFolder: () => path.join(dir, "Aniverse") });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("written in manga/ and recorded as a completed chapter", async () => {
    const result = await saver.save(request());
    expect(result.ok).toBe(true);
    const record = manager.getRecord(result.id);
    expect(record).toMatchObject({
      status: "completed",
      mediaType: "manga",
      chapter: { id: "c-12", number: "12", kind: "chapter" },
      pageCount: 20,
      watchPath: "/read/chainsaw-man/c-12",
    });
    expect(record.outputPath).toBe(path.join(dir, "Aniverse", "manga", "chainsaw-man-chapter-12.avm"));
    expect(fs.readFileSync(record.outputPath).subarray(0, 4).toString("latin1")).toBe("AVM1");
    expect(sent.some(([channel, payload]) => channel === "download:update" && payload.id === result.id)).toBe(true);
    expect(manager.history()[0]).toMatchObject({ id: result.id, fileExists: true });
  });

  test("the same chapter again replaces its file and its record", async () => {
    const first = await saver.save(request());
    const second = await saver.save(request({ bytes: avm("-newer") }));
    expect(second.ok).toBe(true);
    expect(manager.getRecord(first.id)).toBeNull();
    const record = manager.getRecord(second.id);
    expect(path.basename(record.outputPath)).toBe("chainsaw-man-chapter-12.avm");
    expect(fs.readFileSync(record.outputPath, "latin1").endsWith("-newer")).toBe(true);
    expect(fs.readdirSync(path.dirname(record.outputPath))).toEqual(["chainsaw-man-chapter-12.avm"]);
    expect(sent.some(([channel, payload]) => channel === "download:deleted" && payload.id === first.id)).toBe(true);
  });

  test("another chapter of the same manga gets its own file", async () => {
    await saver.save(request());
    const other = await saver.save(request({ chapter: { id: "c-13", number: "13", title: null, kind: "chapter" } }));
    expect(path.basename(manager.getRecord(other.id).outputPath)).toBe("chainsaw-man-chapter-13.avm");
  });

  test("a bad request is refused, nothing written", async () => {
    expect(await saver.save(request({ bytes: new Uint8Array([1, 2, 3]) }))).toEqual({ ok: false, error: "invalid-request" });
    expect(fs.existsSync(path.join(dir, "Aniverse", "manga"))).toBe(false);
  });

  test("the media scheme serves the chapter's file, never as a video", async () => {
    const result = await saver.save(request());
    const media = createMediaServer({ getRecord: (id) => manager.getRecord(result.id === id ? id : "none"), root: path.join(dir, "media") });
    const response = await media.handle(new Request(chapterUrl(result.id)));
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer()).subarray(0, 4).toString("latin1")).toBe("AVM1");
    expect((await media.handle(new Request(`aniverse-media://video/${result.id}`))).status).toBe(404);
    expect(media.playback(result.id)).toBeNull();
  });
});

describe("files opened from the file explorer", () => {
  let dir;
  let media;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aniverse-opened-"));
    media = createMediaServer({ getRecord: () => null, root: path.join(dir, "media") });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("an .avm file gets a token the page reads it by, the same one each time", async () => {
    const file = path.join(dir, "chainsaw-man-chapter-12.avm");
    fs.writeFileSync(file, Buffer.from(avm()));
    const token = media.openFile(file);
    expect(token).toMatch(/^[0-9a-f-]{36}$/);
    expect(media.openFile(file)).toBe(token);
    const response = await media.handle(new Request(`aniverse-media://opened/${token}`));
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer()).subarray(0, 4).toString("latin1")).toBe("AVM1");
  });

  test("refused: another extension, not an .avm inside, missing; unknown tokens are 404", async () => {
    const renamed = path.join(dir, "photo.avm");
    fs.writeFileSync(renamed, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6]));
    const other = path.join(dir, "chapter.zip");
    fs.writeFileSync(other, Buffer.from(avm()));
    expect(media.openFile(renamed)).toBeNull();
    expect(media.openFile(other)).toBeNull();
    expect(media.openFile(path.join(dir, "missing.avm"))).toBeNull();
    expect(media.openFile(dir)).toBeNull();
    const response = await media.handle(new Request("aniverse-media://opened/0f8fad5b-d9cb-469f-a165-70867728950e"));
    expect(response.status).toBe(404);
  });
});
