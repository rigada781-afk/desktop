// ─── Quality probe ───────────────────────────────────────────────────────────
// What the quality dialog lists before a download starts: one entry per
// height (exactly the variant start() picks for that maxHeight), the
// episode's duration and an estimated size. The whole answer comes within
// ~12 s; successful answers are cached 2 minutes in memory. The stream
// headers are only sent with the requests: never stored, never logged.

const hls = require("./hls");
const { createHttp } = require("./http");
const { validateStream } = require("./request");
const { fetchPlaylist, withUserAgent } = require("./job");
const { DownloadError, abortError } = require("./errors");

const BUDGET_MS = 12_000; // the whole answer
const SAMPLE_BUDGET_MS = 9_000; // later than this, sizes come from the bandwidth
const REQUEST_TIMEOUT_MS = 6_000;
const REQUEST_ATTEMPTS = 2;
const MAX_VARIANTS = 6;
// Segments sampled per playlist: 3 left the estimate ~20 % off on zoko
// (segments of 2 to 15 s), 9 about 10 %; one-byte requests, in parallel.
const SAMPLES = 9;
const MAX_INIT_SECTIONS = 2;
const CACHE_TTL_MS = 2 * 60_000;
const CACHE_MAX = 32;
const ORIGINAL_LABEL = "Qualité d’origine";
const PROBE_ERRORS = new Set(["forbidden", "expired", "network", "unsupported"]);

// The answer's error code: aborts (the budget) and anything unexpected are
// "network", the site offers to try again.
function probeErrorCode(err) {
  return err instanceof DownloadError && PROBE_ERRORS.has(err.code) ? err.code : "network";
}

function roundSeconds(seconds) {
  return Number.isFinite(seconds) ? Math.round(seconds * 1000) / 1000 : null;
}

// Up to `count` indexes spread over [0, n): the middle of each equal slice.
function spreadIndexes(n, count) {
  if (n <= count) return Array.from({ length: n }, (_, i) => i);
  return Array.from({ length: count }, (_, i) => Math.floor(((i + 0.5) * n) / count));
}

/**
 * One variant per height, tallest first (at most 6): for each height the
 * one pickVariant() returns for that maxHeight, so the quality listed is the
 * one downloaded. Variants without RESOLUTION (audio-only ones) are left out
 * when others have one; when none has, the default pick alone.
 */
function listVariants(variants) {
  const heights = [...new Set(variants.map((v) => v.height).filter(Boolean))].sort(
    (a, b) => b - a,
  );
  if (!heights.length) {
    const best = hls.pickVariant(variants);
    return best ? [best] : [];
  }
  return heights.slice(0, MAX_VARIANTS).map((height) => hls.pickVariant(variants, height));
}

// What the job refuses, refused here too.
function checkMedia(playlist) {
  if (!playlist.endList) {
    throw new DownloadError("unsupported", "live playlist (no EXT-X-ENDLIST)");
  }
  if (!playlist.segments.length) {
    throw new DownloadError("unsupported", "playlist without segments");
  }
  return playlist;
}

/**
 * { bytes, exact } for one media playlist. BYTERANGE lengths are exact; other
 * segments are sampled (one-byte ranged GETs, up to 3 spread over the
 * playlist) and scaled to the whole duration. bytes is null when nothing
 * could be measured. A failed sample never fails the probe.
 */
async function estimateMedia(playlist, { http, headers, sampleSignal, samples = SAMPLES }) {
  let known = 0;
  const unranged = [];
  const rangedInits = new Set();
  const inits = new Set(); // init sections without BYTERANGE (their URIs)
  for (const seg of playlist.segments) {
    if (seg.byteRange) known += seg.byteRange.length;
    else unranged.push(seg);
    if (!seg.map) continue;
    const range = seg.map.byteRange;
    if (!range) {
      inits.add(seg.map.uri);
      continue;
    }
    const key = `${seg.map.uri}|${range.offset}|${range.length}`;
    if (!rangedInits.has(key)) {
      rangedInits.add(key);
      known += range.length;
    }
  }
  if (!unranged.length && !inits.size) return { bytes: known, exact: true };

  const size = (uri) => http.getSize(uri, { headers, signal: sampleSignal }).catch(() => null);
  const picks = spreadIndexes(unranged.length, samples).map((i) => unranged[i]);
  const [sizes, initSizes] = await Promise.all([
    Promise.all(picks.map((seg) => size(seg.uri))),
    Promise.all([...inits].slice(0, MAX_INIT_SECTIONS).map(size)),
  ]);
  const initsKnown = initSizes.length === inits.size && initSizes.every((s) => s != null);
  known += initSizes.reduce((sum, s) => sum + (s ?? 0), 0);
  if (!unranged.length) return { bytes: known, exact: initsKnown };

  const measured = picks.filter((_, i) => sizes[i] != null);
  if (!measured.length) return { bytes: null, exact: false };
  const sampledBytes = sizes.reduce((sum, s) => sum + (s ?? 0), 0);
  if (measured.length === unranged.length) {
    return { bytes: known + sampledBytes, exact: initsKnown };
  }
  // Segments vary in length (zoko: 2 to 15 s): the samples' bytes per second
  // × the duration; the plain average × count when EXTINF gives no time.
  const sampledSeconds = measured.reduce((sum, s) => sum + s.duration, 0);
  const totalSeconds = unranged.reduce((sum, s) => sum + s.duration, 0);
  const estimate =
    sampledSeconds > 0 && totalSeconds > 0
      ? (sampledBytes / sampledSeconds) * totalSeconds
      : (sampledBytes / measured.length) * unranged.length;
  return { bytes: Math.round(known + estimate), exact: false };
}

function quality(variant, size) {
  const bandwidth = variant ? variant.averageBandwidth ?? (variant.bandwidth || null) : null;
  return {
    height: variant?.height ?? null,
    width: variant?.width ?? null,
    bandwidth,
    label: hls.qualityLabel(variant) ?? ORIGINAL_LABEL,
    sizeBytes: size?.bytes ?? null,
    sizeExact: size?.bytes != null && size.exact === true,
  };
}

// ── HLS ─────────────────────────────────────────────────────────────────────

async function loadMedia(ctx, uri) {
  const loaded = await fetchPlaylist(ctx.http, uri, ctx.headers, ctx.signal);
  if (hls.isMasterPlaylist(loaded.text)) {
    throw new DownloadError("unsupported", "nested master playlist");
  }
  return checkMedia(hls.parseMedia(loaded.text, loaded.url));
}

// The variant's media playlist and its audio rendition (as the job loads
// them), measured. An audio rendition shared by several variants is loaded
// and sampled once.
async function probeVariant(ctx, master, variant, audioByUri) {
  const rendition = hls.pickAudioRendition(master, variant);
  let audio = null;
  if (rendition) {
    audio = audioByUri.get(rendition.uri);
    if (!audio) {
      audio = loadMedia(ctx, rendition.uri).then((media) => estimateMedia(media, ctx));
      audioByUri.set(rendition.uri, audio);
    }
  }
  const [videoSize, audioSize] = await Promise.all([
    loadMedia(ctx, variant.uri).then(async (media) => ({
      durationSec: media.totalDuration,
      ...(await estimateMedia(media, ctx)),
    })),
    audio,
  ]);
  if (videoSize.bytes == null || (audioSize && audioSize.bytes == null)) {
    return { durationSec: videoSize.durationSec, size: null };
  }
  return {
    durationSec: videoSize.durationSec,
    size: {
      bytes: videoSize.bytes + (audioSize?.bytes ?? 0),
      exact: videoSize.exact && (!audioSize || audioSize.exact),
    },
  };
}

async function probeHls(ctx, source) {
  const first = await fetchPlaylist(ctx.http, source, ctx.headers, ctx.signal);

  // A media playlist given directly: one quality.
  if (!hls.isMasterPlaylist(first.text)) {
    const media = checkMedia(hls.parseMedia(first.text, first.url));
    return {
      durationSec: roundSeconds(media.totalDuration),
      qualities: [quality(null, await estimateMedia(media, ctx))],
    };
  }

  const master = hls.parseMaster(first.text, first.url);
  const listed = listVariants(master.variants);
  if (!listed.length) throw new DownloadError("unsupported", "master playlist without variants");

  const audioByUri = new Map();
  const results = await Promise.all(
    listed.map((variant) =>
      probeVariant(ctx, master, variant, audioByUri).then(
        (value) => ({ value }),
        (error) => ({ error }),
      ),
    ),
  );
  const loaded = results.find((r) => r.value);
  if (!loaded) throw results[0].error;
  const durationSec = loaded.value.durationSec;

  const qualities = [];
  listed.forEach((variant, i) => {
    const { value, error } = results[i];
    // The job could not download it either (live, SAMPLE-AES, …).
    if (error && probeErrorCode(error) === "unsupported") return;
    const entry = quality(variant, value?.size);
    // Not measured (failed samples, a variant that did not answer in time):
    // the declared bandwidth × the duration.
    const seconds = value?.durationSec ?? durationSec;
    if (entry.sizeBytes == null && entry.bandwidth && seconds) {
      entry.sizeBytes = Math.round((entry.bandwidth * seconds) / 8);
      entry.sizeExact = false;
    }
    qualities.push(entry);
  });
  if (!qualities.length) throw results.find((r) => r.error).error;
  return { durationSec: roundSeconds(durationSec), qualities };
}

// ── Direct file (kind "mp4") ────────────────────────────────────────────────

async function probeFile(ctx, source) {
  const bytes = await ctx.http.getSize(source, { headers: ctx.headers, signal: ctx.signal });
  return { durationSec: null, qualities: [quality(null, { bytes, exact: true })] };
}

/**
 * @param {object} [options]
 * @param {string | null} [options.userAgent]  sent when the stream has no User-Agent
 * @param {ReturnType<typeof createHttp>} [options.http]
 * @param {typeof fetch} [options.fetch]  for the default http (tests)
 * @param {(ms: number, signal?: AbortSignal) => Promise<void>} [options.sleep]
 * @param {() => number} [options.now]
 */
function createQualityProbe(options = {}) {
  const {
    userAgent = null,
    http = createHttp({
      fetch: options.fetch,
      sleep: options.sleep,
      timeoutMs: REQUEST_TIMEOUT_MS,
      attempts: REQUEST_ATTEMPTS,
    }),
    now = Date.now,
    budgetMs = BUDGET_MS,
    sampleBudgetMs = SAMPLE_BUDGET_MS,
    samples = SAMPLES,
    cacheTtlMs = CACHE_TTL_MS,
  } = options;

  const cache = new Map(); // `${kind} ${source}` → { at, answer }, oldest first
  const pending = new Map(); // same key → the probe in flight

  function cached(key) {
    const hit = cache.get(key);
    if (!hit) return null;
    if (now() - hit.at < cacheTtlMs) return hit.answer;
    cache.delete(key);
    return null;
  }

  function remember(key, answer) {
    cache.delete(key);
    cache.set(key, { at: now(), answer });
    for (const [k, entry] of cache) {
      if (cache.size <= CACHE_MAX && now() - entry.at < cacheTtlMs) break;
      cache.delete(k);
    }
  }

  async function run(stream) {
    const deadline = new AbortController();
    const sampling = new AbortController();
    const timer = setTimeout(() => deadline.abort(abortError("timeout")), budgetMs);
    const sampleTimer = setTimeout(() => sampling.abort(abortError("timeout")), sampleBudgetMs);
    timer.unref?.();
    sampleTimer.unref?.();
    const ctx = {
      http,
      headers: withUserAgent(stream.headers, userAgent),
      signal: deadline.signal,
      sampleSignal: AbortSignal.any([deadline.signal, sampling.signal]),
      samples,
    };
    try {
      const result =
        stream.kind === "mp4"
          ? await probeFile(ctx, stream.source)
          : await probeHls(ctx, stream.source);
      return { ok: true, ...result };
    } catch (err) {
      const error = probeErrorCode(err);
      // DownloadError messages name the host at most (no URL, no header).
      const detail = err instanceof DownloadError ? ` (${err.message})` : "";
      console.warn(`[download] quality probe failed: ${error}${detail}`);
      return { ok: false, error };
    } finally {
      clearTimeout(timer);
      clearTimeout(sampleTimer);
      // Samples still running once the answer is known (another variant
      // failed first) are dropped.
      deadline.abort(abortError("cancel"));
    }
  }

  /**
   * download.qualities(input): { source, kind?, headers? }, validated like
   * start(). Resolves the contract's DownloadQualityProbe, never rejects.
   */
  async function probe(input) {
    const parsed = validateStream(input);
    if (!parsed.ok) return { ok: false, error: "invalid-request" };
    const stream = parsed.stream;
    const key = `${stream.kind} ${stream.source}`;
    const hit = cached(key);
    if (hit) return structuredClone(hit);
    let running = pending.get(key);
    if (!running) {
      running = run(stream)
        .then((answer) => {
          if (answer.ok) remember(key, answer);
          return answer;
        })
        .finally(() => pending.delete(key));
      pending.set(key, running);
    }
    return structuredClone(await running);
  }

  return { probe };
}

module.exports = {
  createQualityProbe,
  listVariants,
  estimateMedia,
  spreadIndexes,
  ORIGINAL_LABEL,
  BUDGET_MS,
  CACHE_TTL_MS,
};
