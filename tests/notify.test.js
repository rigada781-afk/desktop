// Download notifications: when one is shown, and its French text.
const { test, expect } = require("bun:test");
const { downloadNotification } = require("../downloads/notify");

const record = (extra = {}) => ({
  id: "1",
  status: "completed",
  anime: { id: "a", title: "Frieren", isMovie: false },
  episode: { number: 3 },
  language: "sub",
  ...extra,
});

const away = { enabled: true, focused: false };

test("completed / failed while the window isn't focused", () => {
  expect(downloadNotification(record(), away)).toEqual({
    title: "Téléchargement terminé",
    body: "Frieren · Épisode 3 · VOSTFR",
  });
  expect(downloadNotification(record({ status: "error", language: "dub" }), away)).toEqual({
    title: "Échec du téléchargement",
    body: "Frieren · Épisode 3 · VF",
  });
  expect(downloadNotification(record({ anime: { id: "m", title: "Suzume", isMovie: true } }), away).body).toBe(
    "Suzume · Film · VOSTFR",
  );
});

test("nothing when the setting is off, the window is focused, or for cancelled / interrupted / legacy records", () => {
  expect(downloadNotification(record(), { enabled: false, focused: false })).toBeNull();
  expect(downloadNotification(record(), { enabled: true, focused: true })).toBeNull();
  for (const status of ["cancelled", "interrupted", "queued", "downloading", "paused"]) {
    expect(downloadNotification(record({ status }), away)).toBeNull();
  }
  expect(downloadNotification({ id: "legacy", status: "completed", fileName: "x.mp4" }, away)).toBeNull();
  expect(downloadNotification(null, away)).toBeNull();
});
