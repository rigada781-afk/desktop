const { describe, test, expect } = require("bun:test");
const fs = require("fs");
const path = require("path");
const hls = require("../downloads/hls");
const { DownloadError } = require("../downloads/errors");

const fixture = (name) => fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8");

const ZOKO_MASTER_URL =
  "https://hls.dramahot.top/p/scxqicy/55ejtphmn9/e38a115ezb/dnfinmtr3wdbax/master.m3u8";
const SAMA_MASTER_URL =
  "https://prx-1357-ant-v.vmget.online/hls2/01/01755/k9m927ql2k8t_,n,l,.urlset/master.m3u8?t=TOKEN&s=1700000000&e=43200";

describe("URL resolution", () => {
  const base = "https://cdn.x/hls/a/master.m3u8?token=abc/def";
  test("relative, root-relative, parent, protocol-relative and absolute URIs", () => {
    expect(hls.resolveUri("720p/index.m3u8", base)).toBe("https://cdn.x/hls/a/720p/index.m3u8");
    expect(hls.resolveUri("/seg/1.ts", base)).toBe("https://cdn.x/seg/1.ts");
    expect(hls.resolveUri("../b/1.ts", base)).toBe("https://cdn.x/hls/b/1.ts");
    expect(hls.resolveUri("//other.cdn/1.ts", base)).toBe("https://other.cdn/1.ts");
    expect(hls.resolveUri("https://o.cdn/x.ts?sig=1", base)).toBe("https://o.cdn/x.ts?sig=1");
  });
  test("the URI's own query string is kept, the base's is not inherited", () => {
    expect(hls.resolveUri("seg-1.ts?t=abc&asn=1", base)).toBe(
      "https://cdn.x/hls/a/seg-1.ts?t=abc&asn=1",
    );
  });
});

describe("attributes", () => {
  test("quoted values keep their commas", () => {
    expect(
      hls.parseAttributes('BANDWIDTH=1,CODECS="avc1.640028,mp4a.40.2",URI="a,b.m3u8",X=Y'),
    ).toEqual({ BANDWIDTH: "1", CODECS: "avc1.640028,mp4a.40.2", URI: "a,b.m3u8", X: "Y" });
  });
});

describe("master playlists (measured)", () => {
  test("zoko: 3 relative variants, highest bandwidth by default", () => {
    const master = hls.parseMaster(fixture("zoko-master.m3u8"), ZOKO_MASTER_URL);
    expect(master.variants.map((v) => v.height)).toEqual([360, 720, 1080]);
    expect(master.variants[2].uri).toBe(
      "https://hls.dramahot.top/p/scxqicy/55ejtphmn9/e38a115ezb/dnfinmtr3wdbax/1080/index.m3u8",
    );
    expect(hls.pickVariant(master.variants).height).toBe(1080);
    expect(hls.qualityLabel(hls.pickVariant(master.variants))).toBe("1080p");
  });

  test("zoko: maxHeight caps the variant, the lowest one when nothing fits", () => {
    const { variants } = hls.parseMaster(fixture("zoko-master.m3u8"), ZOKO_MASTER_URL);
    expect(hls.pickVariant(variants, 720).height).toBe(720);
    expect(hls.pickVariant(variants, 1000).height).toBe(720);
    expect(hls.pickVariant(variants, 360).height).toBe(360);
    expect(hls.pickVariant(variants, 100).height).toBe(360);
  });

  test("maxHeight: the tallest fitting height, then its highest bandwidth", () => {
    const variants = [
      { uri: "a", height: 1080, bandwidth: 4_000_000 },
      { uri: "b", height: 1080, bandwidth: 6_000_000 },
      { uri: "c", height: 720, bandwidth: 7_000_000 },
      { uri: "d", height: null, bandwidth: 9_000_000 },
    ];
    // A lower height with more bandwidth no longer wins the 1080p choice.
    expect(hls.pickVariant(variants, 1080).uri).toBe("b");
    expect(hls.pickVariant(variants, 2160).uri).toBe("b");
    expect(hls.pickVariant(variants, 720).uri).toBe("c");
    // No cap: the highest bandwidth, as before.
    expect(hls.pickVariant(variants).uri).toBe("d");
  });

  test("maxHeight on a master without RESOLUTION: the best variant, not the worst", () => {
    const variants = [
      { uri: "low", height: null, bandwidth: 800_000 },
      { uri: "high", height: null, bandwidth: 5_000_000 },
    ];
    // A "1080p" default quality gives what the dialog's single choice gives
    expect(hls.pickVariant(variants, 1080).uri).toBe("high");
    expect(hls.pickVariant(variants, 480).uri).toBe("high");
  });

  test("Anime-Sama: absolute tokenised variants, I-frame streams ignored", () => {
    const master = hls.parseMaster(fixture("animesama-master.m3u8"), SAMA_MASTER_URL);
    expect(master.variants).toHaveLength(2);
    expect(master.variants.every((v) => !v.uri.includes("iframes"))).toBe(true);
    const best = hls.pickVariant(master.variants);
    expect(best.height).toBe(1080);
    expect(best.codecs).toBe("avc1.640028,mp4a.40.2");
    expect(best.uri).toContain("/k9m927ql2k8t_n/index-v1-a1.m3u8?t=TOKEN&s=1700000000");
    expect(hls.pickVariant(master.variants, 480).width).toBe(852);
  });

  test("audio groups: the default rendition with a URI", () => {
    const text = [
      "#EXTM3U",
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Japanese",LANGUAGE="ja",DEFAULT=NO,URI="audio/ja.m3u8"',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Français",LANGUAGE="fr",DEFAULT=YES,AUTOSELECT=YES,URI="/audio/fr.m3u8?x=1"',
      '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="fr",URI="subs.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720,AUDIO="aud"',
      "v720.m3u8",
      '#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=640x360,AUDIO="muxed"',
      "v360.m3u8",
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="muxed",NAME="main",DEFAULT=YES',
    ].join("\n");
    const master = hls.parseMaster(text, "https://cdn.x/a/master.m3u8");
    expect(master.audio).toHaveLength(3);
    const rendition = hls.pickAudioRendition(master, master.variants[0]);
    expect(rendition.language).toBe("fr");
    expect(rendition.uri).toBe("https://cdn.x/audio/fr.m3u8?x=1");
    // A group whose rendition has no URI: the audio is in the variant.
    expect(hls.pickAudioRendition(master, master.variants[1])).toBeNull();
    expect(hls.pickAudioRendition(master, { audio: null })).toBeNull();
  });

  test("a media playlist is not a master", () => {
    expect(hls.isMasterPlaylist(fixture("zoko-media-360.m3u8"))).toBe(false);
    expect(hls.isMasterPlaylist(fixture("zoko-master.m3u8"))).toBe(true);
    expect(hls.isPlaylist("<html>nope</html>")).toBe(false);
    expect(hls.isPlaylist("﻿#EXTM3U\n")).toBe(true);
  });
});

describe("media playlists (measured)", () => {
  test("zoko 360p: 195 absolute segments on another host, ENDLIST", () => {
    const base = ZOKO_MASTER_URL.replace("master.m3u8", "360/index.m3u8");
    const media = hls.parseMedia(fixture("zoko-media-360.m3u8"), base);
    expect(media.segments).toHaveLength(195);
    expect(media.endList).toBe(true);
    expect(media.segments[0].uri).toMatch(/^https:\/\/hls1\.drama1\.cfd\/s\/.+\/360\/seg_00000\.ts\.jpg$/);
    expect(media.segments[0].seq).toBe(0);
    expect(media.segments.every((s) => !s.key && !s.map && !s.byteRange)).toBe(true);
    expect(media.totalDuration).toBeGreaterThan(1500);
    expect(media.totalDuration).toBeLessThan(1600);
  });

  test("Anime-Sama 1080p: MEDIA-SEQUENCE 1, token query on every segment", () => {
    const media = hls.parseMedia(fixture("animesama-media-1080.m3u8"), SAMA_MASTER_URL);
    expect(media.segments).toHaveLength(157);
    expect(media.mediaSequence).toBe(1);
    expect(media.segments[0].seq).toBe(1);
    expect(media.segments[156].seq).toBe(157);
    expect(media.segments[156].duration).toBeCloseTo(0.018, 5);
    expect(media.segments[3].uri).toContain("seg-4-v1-a1.ts?t=TOKEN");
    expect(media.totalDuration).toBeCloseTo(1560.018, 2);
  });
});

describe("media playlists (synthetic)", () => {
  const base = "https://cdn.x/v1/stream/abc/720/index.m3u8?sig=1";

  test("AES-128 keys: IV, sequence IV, NONE resets", () => {
    const text = [
      "#EXTM3U",
      "#EXT-X-TARGETDURATION:6",
      "#EXT-X-MEDIA-SEQUENCE:7",
      '#EXT-X-KEY:METHOD=AES-128,URI="/v1/stream/abc/key",IV=0x0000000000000000000000000000000A',
      "#EXTINF:6,",
      "s0.ts",
      '#EXT-X-KEY:METHOD=AES-128,URI="key2?x=1"',
      "#EXTINF:6,",
      "s1.ts",
      "#EXT-X-KEY:METHOD=NONE",
      "#EXTINF:3.5,",
      "s2.ts",
      "#EXT-X-ENDLIST",
    ].join("\r\n");
    const media = hls.parseMedia(text, base);
    const [a, b, c] = media.segments;
    expect(a.key.uri).toBe("https://cdn.x/v1/stream/abc/key");
    expect(a.key.iv.toString("hex")).toBe("0000000000000000000000000000000a");
    expect(a.seq).toBe(7);
    expect(b.key.uri).toBe("https://cdn.x/v1/stream/abc/720/key2?x=1");
    expect(b.key.iv).toBeNull();
    expect(b.seq).toBe(8);
    expect(c.key).toBeNull();
    expect(media.totalDuration).toBe(15.5);
  });

  test("SAMPLE-AES and non-identity key formats are unsupported", () => {
    const sample = '#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="k"\n#EXTINF:1,\na.ts\n#EXT-X-ENDLIST';
    expect(() => hls.parseMedia(sample, base)).toThrow(DownloadError);
    try {
      hls.parseMedia(sample, base);
    } catch (err) {
      expect(err.code).toBe("unsupported");
    }
    const widevine =
      '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="k",KEYFORMAT="com.widevine"\n#EXTINF:1,\na.ts';
    expect(() => hls.parseMedia(widevine, base)).toThrow(DownloadError);
  });

  test("fMP4: EXT-X-MAP with BYTERANGE, segment BYTERANGE with and without offset", () => {
    const text = [
      "#EXTM3U",
      "#EXT-X-VERSION:7",
      '#EXT-X-MAP:URI="main.mp4",BYTERANGE="720@0"',
      "#EXT-X-BYTERANGE:1000@720",
      "#EXTINF:4,",
      "main.mp4",
      "#EXT-X-BYTERANGE:2000",
      "#EXTINF:4,",
      "main.mp4",
      "#EXT-X-ENDLIST",
    ].join("\n");
    const media = hls.parseMedia(text, base);
    expect(media.segments[0].map).toEqual({
      uri: "https://cdn.x/v1/stream/abc/720/main.mp4",
      byteRange: { offset: 0, length: 720 },
      key: null,
    });
    expect(media.segments[0].byteRange).toEqual({ offset: 720, length: 1000 });
    expect(media.segments[1].byteRange).toEqual({ offset: 1720, length: 2000 });
  });

  test("tags between EXTINF and the URI, DISCONTINUITY, GAP, no ENDLIST", () => {
    const text = [
      "#EXTM3U",
      "#EXTINF:5,title",
      "#EXT-X-PROGRAM-DATE-TIME:2026-10-10T10:00:00Z",
      "#EXT-X-BITRATE:900",
      "a.ts",
      "#EXT-X-DISCONTINUITY",
      "#EXTINF:5,",
      "b.ts",
      "#EXTINF:5,",
      "#EXT-X-GAP",
      "gap.ts",
      "#EXTINF:5,",
      "c.ts",
    ].join("\n");
    const media = hls.parseMedia(text, base);
    expect(media.segments.map((s) => path.basename(s.uri))).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(media.segments.map((s) => s.discontinuity)).toEqual([false, true, false]);
    expect(media.segments.map((s) => s.seq)).toEqual([0, 1, 3]);
    expect(media.endList).toBe(false);
  });
});

describe("local playlist", () => {
  test("decrypted local files, MAP once, discontinuities kept, ENDLIST", () => {
    const text = hls.buildLocalPlaylist([
      { file: "video/00000.m4s", duration: 4, mapFile: "video/init-0.mp4" },
      { file: "video/00001.m4s", duration: 3.25, mapFile: "video/init-0.mp4" },
      { file: "video/00002.m4s", duration: 6.4, discontinuity: true, mapFile: "video/init-1.mp4" },
    ]);
    expect(text).toBe(
      [
        "#EXTM3U",
        "#EXT-X-VERSION:6",
        "#EXT-X-TARGETDURATION:7",
        "#EXT-X-MEDIA-SEQUENCE:0",
        "#EXT-X-PLAYLIST-TYPE:VOD",
        '#EXT-X-MAP:URI="video/init-0.mp4"',
        "#EXTINF:4,",
        "video/00000.m4s",
        "#EXTINF:3.25,",
        "video/00001.m4s",
        "#EXT-X-DISCONTINUITY",
        '#EXT-X-MAP:URI="video/init-1.mp4"',
        "#EXTINF:6.4,",
        "video/00002.m4s",
        "#EXT-X-ENDLIST",
        "",
      ].join("\n"),
    );
    expect(text).not.toContain("EXT-X-KEY");
  });

  test("round trip through the parser", () => {
    const text = hls.buildLocalPlaylist([
      { file: "video/00000.ts", duration: 10 },
      { file: "video/00001.ts", duration: 0.018 },
    ]);
    const media = hls.parseMedia(text, "file:///tmp/x/video.m3u8");
    expect(media.endList).toBe(true);
    expect(media.segments.map((s) => s.duration)).toEqual([10, 0.018]);
  });
});
