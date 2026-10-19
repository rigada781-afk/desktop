// ─── Download notifications ──────────────────────────────────────────────────
// Whether a finished job gets a native notification, and its French text.
// Only completions and failures, only with the setting on and the window
// not focused (the site's own toasts and popover cover the focused case).
// Cancelled (the user's own action) and interrupted (a quit) stay silent.

function describe(record) {
  const title = typeof record?.anime?.title === "string" ? record.anime.title : "";
  const language = record?.language === "dub" ? "VF" : "VOSTFR";
  const what = record?.anime?.isMovie
    ? "Film"
    : Number.isFinite(record?.episode?.number)
      ? `Épisode ${record.episode.number}`
      : null;
  return [title, what, language].filter(Boolean).join(" · ");
}

/**
 * @param {object} record  the finished record
 * @param {{ enabled: boolean, focused: boolean }} context
 * @returns {{ title: string, body: string } | null}
 */
function downloadNotification(record, { enabled, focused }) {
  if (!enabled || focused || !record?.anime) return null;
  if (record.status === "completed") return { title: "Téléchargement terminé", body: describe(record) };
  if (record.status === "error") return { title: "Échec du téléchargement", body: describe(record) };
  return null;
}

module.exports = { downloadNotification, describeDownload: describe };
