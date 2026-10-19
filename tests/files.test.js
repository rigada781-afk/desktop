const { describe, test, expect } = require("bun:test");
const path = require("path");
const {
  MAX_NAME_LENGTH,
  sanitizeFileName,
  buildFileName,
  partPathFor,
  pathKey,
  assertInside,
  uniqueOutputPath,
} = require("../downloads/files");

const anime = (title, extra = {}) => ({ id: "a", title, ...extra });

describe("sanitizeFileName", () => {
  test("Windows-forbidden characters", () => {
    expect(sanitizeFileName("Re:Zero")).toBe("Re-Zero.mp4");
    expect(sanitizeFileName("Kaguya-sama: Love Is War")).toBe("Kaguya-sama - Love Is War.mp4");
    expect(sanitizeFileName("Fate/Zero \\ A|B")).toBe("Fate-Zero - A-B.mp4");
    expect(sanitizeFileName('Quoi ? "Non" <ok> *')).toBe("Quoi 'Non' ok.mp4");
  });

  test("control, bidi and zero-width characters", () => {
    expect(sanitizeFileName("a\u0000b\u001fc\u007f")).toBe("abc.mp4");
    expect(sanitizeFileName("evil‮4pm.exe")).toBe("evil4pm.exe.mp4");
    expect(sanitizeFileName("x​y")).toBe("xy.mp4");
  });

  test("trailing dots / spaces, leading dots, empty names", () => {
    expect(sanitizeFileName("Title... ")).toBe("Title.mp4");
    expect(sanitizeFileName("..hidden")).toBe("hidden.mp4");
    expect(sanitizeFileName("  ")).toBe("Aniverse.mp4");
    expect(sanitizeFileName("???")).toBe("Aniverse.mp4");
  });

  test("reserved device names", () => {
    expect(sanitizeFileName("CON")).toBe("_CON.mp4");
    expect(sanitizeFileName("nul.txt")).toBe("_nul.txt.mp4");
    expect(sanitizeFileName("com1")).toBe("_com1.mp4");
    expect(sanitizeFileName("Console")).toBe("Console.mp4");
  });

  test("at most 150 characters, no split surrogate pair", () => {
    expect(sanitizeFileName("a".repeat(400)).length).toBe(MAX_NAME_LENGTH);
    const emoji = sanitizeFileName("😀".repeat(200));
    expect(emoji.length).toBeLessThanOrEqual(MAX_NAME_LENGTH);
    expect(emoji).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });
});

describe("buildFileName", () => {
  test("series: <slug>-ep-<n>.mp4, VF with -vf", () => {
    const episode = { number: 1 };
    expect(buildFileName({ anime: anime("Chainsaw Man", { slug: "chainsaw-man" }), episode, language: "sub" })).toBe(
      "chainsaw-man-ep-1.mp4",
    );
    expect(buildFileName({ anime: anime("Re:Zéro – Starting Life"), episode: { number: 12.5 }, language: "dub" }))
      .toBe("re-zero-starting-life-ep-12-5-vf.mp4");
  });

  test("the site's permalink first, the title without one", () => {
    expect(buildFileName({ anime: anime("Frieren", { slug: "sousou-no-frieren" }), episode: { number: 3 }, language: "sub" }))
      .toBe("sousou-no-frieren-ep-3.mp4");
    expect(buildFileName({ anime: anime("!!!", { slug: null }), episode: { number: 3 }, language: "sub" }))
      .toBe("aniverse-ep-3.mp4");
  });

  test("movies", () => {
    expect(
      buildFileName({
        anime: anime("Your Name.", { isMovie: true }),
        episode: { number: 1 },
        language: "dub",
      }),
    ).toBe("your-name-vf.mp4");
  });

  test("a long title is shortened, the episode number survives", () => {
    const name = buildFileName({
      anime: anime("T".repeat(300)),
      episode: { number: 1100 },
      language: "sub",
    });
    expect(name.length).toBeLessThanOrEqual(MAX_NAME_LENGTH);
    expect(name.endsWith("-ep-1100.mp4")).toBe(true);
  });
});

describe("output paths", () => {
  const folder = path.resolve("/tmp/Aniverse");

  test("part file next to the final one", () => {
    expect(partPathFor(path.join(folder, "A.mp4"))).toBe(path.join(folder, "A.part.mp4"));
  });

  test("de-duplication: (2), (3) … against existing files and other jobs", () => {
    const taken = new Set([
      pathKey(path.join(folder, "Frieren - Épisode 1 (VOSTFR).mp4")),
      pathKey(path.join(folder, "Frieren - Épisode 1 (VOSTFR) (2).mp4")),
    ]);
    const out = uniqueOutputPath(folder, "Frieren - Épisode 1 (VOSTFR).mp4", (p) =>
      taken.has(pathKey(p)),
    );
    expect(out.fileName).toBe("Frieren - Épisode 1 (VOSTFR) (3).mp4");
    expect(out.outputPath).toBe(path.join(folder, out.fileName));
  });

  test("case-insensitive comparison key", () => {
    expect(pathKey(path.join(folder, "A.MP4"))).toBe(pathKey(path.join(folder, "a.mp4")));
  });

  test("a path outside the folder is refused", () => {
    expect(() => assertInside(folder, path.join(folder, "..", "x.mp4"))).toThrow();
    expect(() => assertInside(folder, path.join(folder, "sub", "x.mp4"))).toThrow();
    expect(assertInside(folder, path.join(folder, "x.mp4"))).toBe(path.join(folder, "x.mp4"));
  });

  test("a drive / file-system root works as the folder", () => {
    const root = path.parse(process.cwd()).root;
    expect(assertInside(root, path.join(root, "x.mp4"))).toBe(path.join(root, "x.mp4"));
  });
});
