// Quality probe against a fetch stub: the measured zoko / Anime-Sama
// playlists, audio renditions, BYTERANGE, sampling and its fallbacks, errors,
// the budget and the cache. The last block checks that a probed height is
// exactly the variant a job downloads for that maxHeight.
const { describe, test, expect, spyOn } = require("bun:test");
const fs = require("fs");
const os = require("os");
const path = require("path");
const hls = require("../downloads/hls");
const { createQualityProbe, listVariants, spreadIndexes, ORIGINAL_LABEL } = require("../downloads/probe");
const { runJob } = require("../downloads/job");
const { createHttp } = require("../downloads/http");
const { validateRequest } = require("../downloads/request");

const fixture = (name) => fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8");
const UA = "AniverseDesktop/test";

const ZOKO_MASTER_URL = "https://hls.dramahot.top/p/scxqicy/55ejtphmn9/e38a115ezb/dnfinmtr3wdbax/master.m3u8";
const SAMA_MASTER_URL =
  "https://prx-1357-ant-v.vmget.online/hls2/01/01755/k9m927ql2k8t_,n,l,.urlset/master.m3u8?t=TOKEN&s=1700000000&e=43200";

const playlist = (text) =>
  new Response(text, { status: 200, headers: { "content-type": "application/vnd.apple.mpegurl" } });

// A one-byte ranged answer for a resource of `total` bytes.
const ranged = (total) =>
  new Response(new Uint8Array([0x47]), {
    status: 206,
    headers: { "content-range": `bytes 0-0/${total}`, "content-type": "video/mp2t" },
  });

const notFound = () => new Response("<html>404</html>", { status: 404, headers: { "content-type": "text/html" } });

// Never answers; rejects when the request is aborted (budget, cancel).
const hang = (init) =>
  new Promise((_, reject) => {
    init.signal?.addEventListener("abort", () => reject(init.signal.reason), { once: true });
  });

// fetch stub: `route(url, init)` → Response | Promise; every call logged.
function cdn(route) {
  const log = [];
  const fetch = async (url, init) => {
    log.push({ url, headers: { ...init.headers } });
    return (await route(url, init)) ?? notFound();
  };
  return { fetch, log };
}

const noSleep = async () => {};

function makeProbe(fetch, extra = {}) {
  // 3 samples per playlist keep the expected request lists short (the app uses 9)
  return createQualityProbe({ fetch, sleep: noSleep, userAgent: UA, samples: 3, ...extra });
}

// Segment URL → duration, for size stubs proportional to the duration.
function durations(text, base) {
  return new Map(hls.parseMedia(text, base).segments.map((s) => [s.uri, s.duration]));
}

const sum = (values) => values.reduce((a, b) => a + b, 0);

describe("helpers", () => {
  test("samples spread over the playlist, all of them when there are few", () => {
    expect(spreadIndexes(195, 3)).toEqual([32, 97, 162]);
    expect(spreadIndexes(157, 3)).toEqual([26, 78, 130]);
    expect(spreadIndexes(2, 3)).toEqual([0, 1]);
    expect(spreadIndexes(0, 3)).toEqual([]);
  });

  test("one variant per height, tallest first, capped at 6, audio-only left out", () => {
    const variants = [144, 240, 360, 480, 576, 720, 900, 1080].map((height, i) => ({
      uri: `v${height}`,
      height,
      bandwidth: (i + 1) * 100_000,
    }));
    variants.push({ uri: "audio", height: null, bandwidth: 64_000 });
    expect(listVariants(variants).map((v) => v.height)).toEqual([1080, 900, 720, 576, 480, 360]);
    // No RESOLUTION anywhere: the default pick alone.
    expect(listVariants([{ uri: "a", height: null, bandwidth: 1 }, { uri: "b", height: null, bandwidth: 2 }]).map((v) => v.uri)).toEqual(["b"]);
  });
});

describe("zoko-like master (relative variants, RESOLUTION, no AVERAGE-BANDWIDTH)", () => {
  const media360 = fixture("zoko-media-360.m3u8");
  const mediaFor = (h) => media360.replaceAll("/360/", `/${h}/`);
  const rates = { 360: 40_000, 720: 160_000, 1080: 300_000 }; // bytes per second
  const segmentDurations = new Map();
  for (const h of [360, 720, 1080]) {
    for (const [uri, d] of durations(mediaFor(h), ZOKO_MASTER_URL)) segmentDurations.set(uri, { d, h });
  }
  const segmentSize = (uri) => {
    const { d, h } = segmentDurations.get(uri);
    return Math.round(d * rates[h]);
  };
  const route = (url) => {
    if (url === ZOKO_MASTER_URL) return playlist(fixture("zoko-master.m3u8"));
    const m = /dnfinmtr3wdbax\/(\d+)\/index\.m3u8$/.exec(url);
    if (m) return playlist(mediaFor(Number(m[1])));
    if (segmentDurations.has(url)) return ranged(segmentSize(url));
  };

  test("three qualities, highest first, sizes from 3 sampled segments each", async () => {
    const { fetch, log } = cdn(route);
    const answer = await makeProbe(fetch).probe({
      source: ZOKO_MASTER_URL,
      kind: "hls",
      headers: { Origin: "https://zokoanime.video", Referer: "https://zokoanime.video/" },
    });
    expect(answer.ok).toBe(true);
    expect(answer.qualities.map((q) => q.label)).toEqual(["1080p", "720p", "360p"]);
    expect(answer.qualities.map((q) => [q.width, q.height, q.bandwidth])).toEqual([
      [1920, 1080, 5_300_000],
      [1280, 720, 3_000_000],
      [640, 360, 900_000],
    ]);
    const parsed = hls.parseMedia(media360, ZOKO_MASTER_URL);
    expect(answer.durationSec).toBeCloseTo(parsed.totalDuration, 3);

    for (const q of answer.qualities) {
      const real = sum(parsed.segments.map((s) => Math.round(s.duration * rates[q.height])));
      expect(q.sizeExact).toBe(false);
      expect(Math.abs(q.sizeBytes - real) / real).toBeLessThan(0.001);
    }

    // The stream headers + the desktop UA on every request; Range only on samples.
    expect(log.every((c) => c.headers.Referer === "https://zokoanime.video/" && c.headers["User-Agent"] === UA)).toBe(true);
    const samples = log.filter((c) => c.headers.Range);
    expect(samples).toHaveLength(9);
    expect(samples.every((c) => c.headers.Range === "bytes=0-0")).toBe(true);
    expect(samples.filter((c) => c.url.includes("/360/")).map((c) => c.url.slice(-17)).sort()).toEqual([
      "seg_00032.ts.jpg",
      "seg_00097.ts.jpg",
      "seg_00162.ts.jpg",
    ].map((s) => `/${s}`));
  });

  test("a User-Agent given by the stream is kept", async () => {
    const { fetch, log } = cdn(route);
    await makeProbe(fetch).probe({ source: ZOKO_MASTER_URL, headers: { "User-Agent": "Scraper/1.0" } });
    expect(log[0].headers).toEqual({ "User-Agent": "Scraper/1.0" });
  });

  test("samples that fail fall back to bandwidth × duration", async () => {
    const { fetch } = cdn((url) => (segmentDurations.has(url) ? notFound() : route(url)));
    const answer = await makeProbe(fetch).probe({ source: ZOKO_MASTER_URL });
    expect(answer.ok).toBe(true);
    for (const q of answer.qualities) {
      expect(q.sizeExact).toBe(false);
      expect(q.sizeBytes).toBe(Math.round((q.bandwidth * answer.durationSec) / 8));
    }
  });

  test("an answer without a total (bytes 0-0/*) is no sample either", async () => {
    const { fetch } = cdn((url) =>
      segmentDurations.has(url)
        ? new Response("G", { status: 206, headers: { "content-range": "bytes 0-0/*" } })
        : route(url),
    );
    const answer = await makeProbe(fetch).probe({ source: ZOKO_MASTER_URL });
    expect(answer.qualities[2].sizeBytes).toBe(Math.round((900_000 * answer.durationSec) / 8));
  });
});

describe("Anime-Sama-like master (absolute tokenised URIs, I-frame streams)", () => {
  const media1080 = fixture("animesama-media-1080.m3u8");
  const media480 = media1080.replaceAll("k9m927ql2k8t_n/", "k9m927ql2k8t_l/");
  const rate = { n: 400_000, l: 78_000 };
  const route = (url) => {
    if (url === SAMA_MASTER_URL) return playlist(fixture("animesama-master.m3u8"));
    const m = /k9m927ql2k8t_([nl])\/(index|seg-(\d+))-v1-a1\.(m3u8|ts)\?t=TOKEN/.exec(url);
    if (!m) return null;
    if (m[2] === "index") return playlist(m[1] === "n" ? media1080 : media480);
    const n = Number(m[3]);
    return ranged(Math.round((n === 157 ? 0.018 : 10) * rate[m[1]]));
  };

  test("two qualities, I-frame playlists never fetched, tokens kept", async () => {
    const { fetch, log } = cdn(route);
    const answer = await makeProbe(fetch).probe({
      source: SAMA_MASTER_URL,
      kind: "hls",
      headers: { Referer: "https://ansembed.net/embed-x.html", "User-Agent": "Mozilla/5.0 (compatible; AnimeSamaScraper/1.0)" },
    });
    expect(answer.ok).toBe(true);
    expect(answer.durationSec).toBeCloseTo(1560.018, 3);
    expect(answer.qualities.map((q) => [q.label, q.width, q.bandwidth])).toEqual([
      ["1080p", 1920, 3_195_550],
      ["480p", 852, 625_325],
    ]);
    expect(log.some((c) => c.url.includes("iframes"))).toBe(false);
    expect(log.every((c) => c.url.includes("t=TOKEN"))).toBe(true);
    const real1080 = 156 * 10 * rate.n + Math.round(0.018 * rate.n);
    expect(Math.abs(answer.qualities[0].sizeBytes - real1080) / real1080).toBeLessThan(0.001);
    expect(log.filter((c) => c.headers.Range).map((c) => /seg-(\d+)/.exec(c.url)[1]).sort()).toEqual(
      ["27", "79", "131", "27", "79", "131"].sort(),
    );
  });
});

describe("other playlists", () => {
  test("AUDIO renditions: added to each variant, loaded and sampled once", async () => {
    const master = [
      "#EXTM3U",
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Japonais",LANGUAGE="ja",DEFAULT=YES,URI="audio/ja.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=2000000,AVERAGE-BANDWIDTH=1500000,RESOLUTION=1280x720,AUDIO="aud"',
      "v720.m3u8",
      '#EXT-X-STREAM-INF:BANDWIDTH=800000,AVERAGE-BANDWIDTH=600000,RESOLUTION=640x360,AUDIO="aud"',
      "v360.m3u8",
    ].join("\n");
    const media = (prefix, count) =>
      ["#EXTM3U", "#EXT-X-TARGETDURATION:6", ...Array.from({ length: count }, (_, i) => `#EXTINF:6,\n${prefix}${i}.ts`), "#EXT-X-ENDLIST"].join("\n");
    const { fetch, log } = cdn((url) => {
      const p = new URL(url).pathname;
      if (p === "/ep/master.m3u8") return playlist(master);
      if (p === "/ep/v720.m3u8") return playlist(media("h", 4));
      if (p === "/ep/v360.m3u8") return playlist(media("l", 4));
      if (p === "/ep/audio/ja.m3u8") return playlist(media("a", 2));
      if (/\/ep\/h\d\.ts$/.test(p)) return ranged(900_000);
      if (/\/ep\/l\d\.ts$/.test(p)) return ranged(300_000);
      if (/\/ep\/audio\/a\d\.ts$/.test(p)) return ranged(96_000);
    });
    const answer = await makeProbe(fetch).probe({ source: "https://cdn.test/ep/master.m3u8" });
    expect(answer.ok).toBe(true);
    expect(answer.durationSec).toBe(24);
    expect(answer.qualities.map((q) => [q.label, q.bandwidth, q.sizeBytes, q.sizeExact])).toEqual([
      ["720p", 1_500_000, 4 * 900_000 + 2 * 96_000, false],
      ["360p", 600_000, 4 * 300_000 + 2 * 96_000, false],
    ]);
    expect(log.filter((c) => c.url.endsWith("/audio/ja.m3u8"))).toHaveLength(1);
    expect(log.filter((c) => /\/audio\/a\d\.ts$/.test(c.url))).toHaveLength(2);
  });

  test("a media playlist given directly: one quality, every segment sampled → exact", async () => {
    const text = "#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\ns0.ts\n#EXTINF:4.5,\ns1.ts\n#EXT-X-ENDLIST\n";
    const { fetch } = cdn((url) => {
      if (url.endsWith("/index.m3u8")) return playlist(text);
      if (url.endsWith("/s0.ts")) return ranged(1_000_000);
      if (url.endsWith("/s1.ts")) return ranged(450_000);
    });
    const answer = await makeProbe(fetch).probe({ source: "https://cdn.test/ep/index.m3u8" });
    expect(answer).toEqual({
      ok: true,
      durationSec: 14.5,
      qualities: [{ height: null, width: null, bandwidth: null, label: ORIGINAL_LABEL, sizeBytes: 1_450_000, sizeExact: true }],
    });
    expect(ORIGINAL_LABEL).toBe("Qualité d’origine");
  });

  test("BYTERANGE (fMP4 single file): the exact sum, no sampling", async () => {
    const text = [
      "#EXTM3U",
      "#EXT-X-VERSION:7",
      "#EXT-X-TARGETDURATION:4",
      '#EXT-X-MAP:URI="main.mp4",BYTERANGE="800@0"',
      "#EXT-X-BYTERANGE:50000@800",
      "#EXTINF:4,",
      "main.mp4",
      "#EXT-X-BYTERANGE:42000",
      "#EXTINF:4,",
      "main.mp4",
      "#EXT-X-BYTERANGE:38000",
      "#EXTINF:2.5,",
      "main.mp4",
      "#EXT-X-ENDLIST",
    ].join("\n");
    const master = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1920x1080\nv/index.m3u8\n";
    const { fetch, log } = cdn((url) => {
      if (url.endsWith("/master.m3u8")) return playlist(master);
      if (url.endsWith("/v/index.m3u8")) return playlist(text);
    });
    const answer = await makeProbe(fetch).probe({ source: "https://cdn.test/master.m3u8" });
    expect(answer.qualities).toEqual([
      { height: 1080, width: 1920, bandwidth: 1_000_000, label: "1080p", sizeBytes: 800 + 50_000 + 42_000 + 38_000, sizeExact: true },
    ]);
    expect(answer.durationSec).toBe(10.5);
    expect(log).toHaveLength(2);
  });

  test("a server that ignores Range: its Content-Length, the body left unread", async () => {
    let cancelled = 0;
    let pulled = 0;
    const big = () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            pulled++;
            controller.enqueue(new Uint8Array(64 * 1024).fill(0x47));
          },
          cancel() {
            cancelled++;
          },
        }),
        { status: 200, headers: { "content-length": "2500000" } },
      );
    const text = "#EXTM3U\n#EXTINF:10,\ns0.ts\n#EXTINF:10,\ns1.ts\n#EXT-X-ENDLIST\n";
    const { fetch } = cdn((url) => (url.endsWith(".m3u8") ? playlist(text) : big()));
    const answer = await makeProbe(fetch).probe({ source: "https://cdn.test/ep/index.m3u8" });
    expect(answer.qualities[0].sizeBytes).toBe(5_000_000);
    expect(answer.qualities[0].sizeExact).toBe(true);
    expect(cancelled).toBe(2);
    expect(pulled).toBeLessThan(10);
  });

  test("kind mp4: one quality, the exact size from Content-Range", async () => {
    const { fetch, log } = cdn((url) => (url.includes("/films/") ? ranged(734_003_200) : null));
    for (const input of [
      { source: "https://cdn.test/films/f.mp4" },
      { source: "https://cdn.test/films/stream?id=1", kind: "mp4" },
    ]) {
      const answer = await makeProbe(fetch).probe(input);
      expect(answer).toEqual({
        ok: true,
        durationSec: null,
        qualities: [{ height: null, width: null, bandwidth: null, label: ORIGINAL_LABEL, sizeBytes: 734_003_200, sizeExact: true }],
      });
    }
    expect(log.every((c) => c.headers.Range === "bytes=0-0")).toBe(true);
  });

  test("a variant whose playlist cannot be downloaded (live) is not listed", async () => {
    const master = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720\nlive.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=640x360\nvod.m3u8\n";
    const { fetch } = cdn((url) => {
      if (url.endsWith("/master.m3u8")) return playlist(master);
      if (url.endsWith("/live.m3u8")) return playlist("#EXTM3U\n#EXTINF:6,\na.ts\n");
      if (url.endsWith("/vod.m3u8")) return playlist("#EXTM3U\n#EXTINF:6,\nb.ts\n#EXT-X-ENDLIST\n");
      if (url.endsWith("/b.ts")) return ranged(500_000);
    });
    const answer = await makeProbe(fetch).probe({ source: "https://cdn.test/master.m3u8" });
    expect(answer.qualities.map((q) => [q.label, q.sizeBytes, q.sizeExact])).toEqual([["360p", 500_000, true]]);
  });
});

describe("errors", () => {
  test("403 → forbidden (retried once), 404 → expired, garbage → unsupported, network → network", async () => {
    const cases = [
      [() => new Response("nope", { status: 403 }), "forbidden", 2],
      [() => notFound(), "expired", 1],
      [() => new Response("hello, not a playlist", { status: 200 }), "unsupported", 2],
      [() => new Response("<html>blocked</html>", { status: 200 }), "forbidden", 2],
      [() => Promise.reject(new TypeError("fetch failed")), "network", 2],
    ];
    for (const [answer, error, calls] of cases) {
      const { fetch, log } = cdn(answer);
      expect(await makeProbe(fetch).probe({ source: "https://cdn.test/master.m3u8" })).toEqual({ ok: false, error });
      expect(log).toHaveLength(calls);
    }
  });

  test("every variant playlist fails → that error", async () => {
    const { fetch } = cdn((url) => (url.endsWith("/master.m3u8") ? playlist(fixture("zoko-master.m3u8")) : new Response("", { status: 403 })));
    expect(await makeProbe(fetch).probe({ source: "https://cdn.test/master.m3u8" })).toEqual({ ok: false, error: "forbidden" });
  });

  test("a mp4 that answers 404 is expired", async () => {
    const { fetch } = cdn(() => notFound());
    expect(await makeProbe(fetch).probe({ source: "https://cdn.test/f.mp4" })).toEqual({ ok: false, error: "expired" });
  });

  test("headers and tokens are never logged", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { fetch } = cdn(() => new Response("", { status: 403 }));
      await makeProbe(fetch).probe({ source: "https://cdn.host/m.m3u8?token=secret-tok", headers: { Authorization: "Bearer secret-jwt" } });
      const logged = JSON.stringify(warn.mock.calls);
      expect(logged).toContain("forbidden");
      expect(logged).not.toContain("secret");
    } finally {
      warn.mockRestore();
    }
  });

  test("invalid input → invalid-request, nothing fetched", async () => {
    const { fetch, log } = cdn(() => playlist("#EXTM3U\n"));
    const probe = makeProbe(fetch);
    for (const input of [
      null,
      "https://cdn.test/m.m3u8",
      {},
      { source: "file:///C:/x.m3u8" },
      { source: "javascript:alert(1)" },
      { source: "https://cdn.test/m.m3u8", kind: "dash" },
      { source: "https://cdn.test/m.m3u8", headers: { "Bad Name": "x" } },
      { source: "https://cdn.test/m.m3u8", headers: { Referer: "a\r\nX-Evil: 1" } },
      { source: `https://cdn.test/${"a".repeat(9000)}` },
    ]) {
      expect(await probe.probe(input)).toEqual({ ok: false, error: "invalid-request" });
    }
    expect(log).toHaveLength(0);
  });
});

describe("budget", () => {
  const master = fixture("zoko-master.m3u8");
  const media = (h) => `#EXTM3U\n#EXTINF:10,\n${h}/s0.ts\n#EXTINF:10,\n${h}/s1.ts\n#EXT-X-ENDLIST\n`;

  test("a variant that does not answer in time: bandwidth × the others' duration", async () => {
    const { fetch } = cdn((url, init) => {
      if (url.endsWith("/master.m3u8")) return playlist(master);
      if (url.endsWith("/1080/index.m3u8")) return hang(init);
      const m = /\/(\d+)\/index\.m3u8$/.exec(url);
      if (m) return playlist(media(m[1]));
      return ranged(1000);
    });
    const started = Date.now();
    const answer = await makeProbe(fetch, { budgetMs: 300, sampleBudgetMs: 150 }).probe({ source: "https://cdn.test/v/master.m3u8" });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(answer.durationSec).toBe(20);
    expect(answer.qualities.map((q) => [q.label, q.sizeBytes, q.sizeExact])).toEqual([
      ["1080p", Math.round((5_300_000 * 20) / 8), false],
      ["720p", 2000, true],
      ["360p", 2000, true],
    ]);
  });

  test("samples past the sampling budget: bandwidth × duration", async () => {
    const { fetch } = cdn((url, init) => {
      if (url.endsWith("/master.m3u8")) return playlist(master);
      const m = /\/(\d+)\/index\.m3u8$/.exec(url);
      if (m) return playlist(media(m[1]));
      return hang(init);
    });
    const answer = await makeProbe(fetch, { budgetMs: 1000, sampleBudgetMs: 100 }).probe({ source: "https://cdn.test/v/master.m3u8" });
    expect(answer.qualities.map((q) => q.sizeBytes)).toEqual(
      [5_300_000, 3_000_000, 900_000].map((b) => Math.round((b * 20) / 8)),
    );
  });

  test("a master that does not answer in time: network", async () => {
    const { fetch } = cdn((_, init) => hang(init));
    const started = Date.now();
    expect(await makeProbe(fetch, { budgetMs: 200 }).probe({ source: "https://cdn.test/v/master.m3u8" })).toEqual({ ok: false, error: "network" });
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("cache", () => {
  const text = "#EXTM3U\n#EXTINF:10,\ns0.ts\n#EXT-X-ENDLIST\n";
  const route = (url) => (url.includes(".m3u8") ? playlist(text) : ranged(1234));

  test("answers kept 2 minutes per full source string", async () => {
    let time = 1_000_000;
    const { fetch, log } = cdn(route);
    const probe = makeProbe(fetch, { now: () => time });
    const source = "https://cdn.test/ep/index.m3u8?token=a";
    const first = await probe.probe({ source });
    expect(log).toHaveLength(2);
    first.qualities[0].sizeBytes = 0; // the caller's copy only
    time += 119_000;
    expect(await probe.probe({ source, headers: { Referer: "https://other/" } })).toEqual({
      ...first,
      qualities: [{ ...first.qualities[0], sizeBytes: 1234 }],
    });
    expect(log).toHaveLength(2);
    // Another token is another source.
    await probe.probe({ source: "https://cdn.test/ep/index.m3u8?token=b" });
    expect(log).toHaveLength(4);
    time += 2_000;
    await probe.probe({ source });
    expect(log).toHaveLength(6);
  });

  test("errors are not cached; parallel calls share one probe", async () => {
    let fail = true;
    const { fetch, log } = cdn((url) => (fail ? notFound() : route(url)));
    const probe = makeProbe(fetch);
    const source = "https://cdn.test/ep/index.m3u8";
    expect((await probe.probe({ source })).error).toBe("expired");
    fail = false;
    const [a, b] = await Promise.all([probe.probe({ source }), probe.probe({ source })]);
    expect(a.ok && b.ok).toBe(true);
    expect(a).toEqual(b);
    expect(log).toHaveLength(3); // 404, then one playlist + one sample
  });
});

describe("the probed height is the variant the job downloads", () => {
  // Same height twice, a lower height with more bandwidth, an audio-only
  // variant: each variant's segments have their own byte length, so the
  // probed size tells which variant the probe measured.
  const variants = [
    { name: "a", res: "1920x1080", bw: 4_000_000, len: 1001 },
    { name: "b", res: "1920x1080", bw: 6_000_000, len: 1002 },
    { name: "c", res: "1280x720", bw: 7_000_000, len: 1003 },
    { name: "d", res: "1280x720", bw: 2_000_000, len: 1004 },
    { name: "e", res: "854x480", bw: 1_000_000, len: 1005 },
    { name: "f", res: null, bw: 128_000, len: 1006 },
  ];
  const master = [
    "#EXTM3U",
    ...variants.flatMap((v) => [
      `#EXT-X-STREAM-INF:BANDWIDTH=${v.bw}${v.res ? `,RESOLUTION=${v.res}` : ',CODECS="mp4a.40.2"'}`,
      `${v.name}/index.m3u8`,
    ]),
  ].join("\n");
  const media = (v) =>
    ["#EXTM3U", "#EXT-X-VERSION:4", ...[0, 1].flatMap((i) => [`#EXT-X-BYTERANGE:${v.len}@${i * v.len}`, "#EXTINF:5,", "all.ts"]), "#EXT-X-ENDLIST"].join("\n");
  const SOURCE = "https://cdn.test/show/master.m3u8";
  const route = (url) => {
    if (url === SOURCE) return playlist(master);
    const v = variants.find((x) => url === `https://cdn.test/show/${x.name}/index.m3u8`);
    return v ? playlist(media(v)) : null;
  };

  // The variant playlist a job asks for with this maxHeight (it stops there:
  // its segments answer 404).
  async function jobVariant(maxHeight) {
    const log = [];
    const fetch = async (url) => {
      log.push(url);
      return url === SOURCE ? playlist(master) : notFound();
    };
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "aniverse-probe-"));
    try {
      const { request } = validateRequest({
        source: SOURCE,
        ...(maxHeight ? { maxHeight } : {}),
        anime: { id: "a", title: "Show" },
        episode: { number: 1 },
        language: "sub",
        watchPath: "/watch/show?ep=1",
      });
      await runJob({
        request,
        outputPath: path.join(root, "out", "Show - Épisode 1 (VOSTFR).mp4"),
        tmpDir: path.join(root, "tmp"),
        signal: new AbortController().signal,
        http: createHttp({ fetch, sleep: noSleep }),
        ffmpegPath: "ffmpeg-unused",
        report: () => {},
      }).catch(() => {});
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
    return /show\/(\w)\/index\.m3u8$/.exec(log[1])[1];
  }

  test("for every listed height, start({ maxHeight }) fetches the probed variant", async () => {
    const { fetch } = cdn(route);
    const answer = await makeProbe(fetch).probe({ source: SOURCE });
    expect(answer.qualities.map((q) => [q.label, q.bandwidth])).toEqual([
      ["1080p", 6_000_000],
      ["720p", 7_000_000],
      ["480p", 1_000_000],
    ]);
    for (const q of answer.qualities) {
      const probed = variants.find((v) => v.len * 2 === q.sizeBytes);
      expect(probed.bw).toBe(q.bandwidth);
      expect(await jobVariant(q.height)).toBe(probed.name);
    }
    // No height chosen (old app / fallback button): the highest bandwidth.
    expect(await jobVariant(null)).toBe("c");
  });
});
