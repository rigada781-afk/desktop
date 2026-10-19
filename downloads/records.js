// ─── Download records ────────────────────────────────────────────────────────
// The shape the site reads (DownloadRecord, API v2). No headers, tokens or
// source URLs, and no UI text: the site derives French labels from
// status / phase / progress / error.code.

const ACTIVE_STATUSES = new Set(["queued", "downloading", "paused"]);

function roundProgress(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(Math.min(100, Math.max(0, n)) * 10) / 10;
}

function buildRecord({ id, request, fileName, outputPath, now }) {
  return {
    id,
    status: "queued",
    phase: null,
    progress: 0,
    // Episodes only for now; chapter downloads will write "manga".
    mediaType: "anime",
    anime: {
      id: request.anime.id,
      title: request.anime.title,
      slug: request.anime.slug ?? null,
      image: request.anime.image ?? null,
      isMovie: request.anime.isMovie === true,
    },
    episode: {
      number: request.episode.number,
      title: request.episode.title ?? null,
      image: request.episode.image ?? null,
    },
    language: request.language,
    watchPath: request.watchPath,
    quality: null,
    subtitles: request.subtitles.map(({ locale, label }) => ({ locale, label })),
    fileName,
    outputPath,
    createdAt: now,
  };
}

function isActive(record) {
  return ACTIVE_STATUSES.has(record?.status);
}

function isSameEpisode(record, request) {
  return (
    record?.anime?.id === request.anime.id &&
    record?.episode?.number === request.episode.number &&
    record?.language === request.language
  );
}

/** Records left active by a previous run (crash, kill) become "interrupted". */
function reconcileRecords(records, now) {
  const interrupted = [];
  const next = records.map((record) => {
    if (!isActive(record)) return record;
    const updated = {
      ...record,
      status: "interrupted",
      phase: null,
      error: { code: "interrupted", message: "" },
      finishedAt: now,
    };
    delete updated.speedBps;
    interrupted.push(updated);
    return updated;
  });
  return { records: next, interrupted };
}

function sortNewestFirst(records) {
  const time = (r) => r.createdAt ?? r.startedAt ?? 0;
  return [...records].sort((a, b) => time(b) - time(a));
}

// Copy for the store / IPC: JSON-safe, without the history-only field.
function storable(record) {
  const copy = { ...record };
  delete copy.fileExists;
  for (const key of Object.keys(copy)) {
    if (copy[key] === undefined) delete copy[key];
  }
  return copy;
}

module.exports = {
  ACTIVE_STATUSES,
  roundProgress,
  buildRecord,
  isActive,
  isSameEpisode,
  reconcileRecords,
  sortNewestFirst,
  storable,
};
