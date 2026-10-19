# Minecraft modpack

Installs the Aniverse modpack into the player's own Minecraft launcher and keeps it up to date. No UI here: the site
(`aniverse.fr`) drives it through `window.aniverseDesktop.minecraft` and shows its own screens.

## How the pack is published

The pack tool (`pack-tool` in the Modrinth App profile) exports `out/client/`: `manifest.json` plus `objects/`
(files named by their sha1). That folder is committed, as plain files, to a branch of a **public** GitHub repo
(`config.MINECRAFT.REPO`, placeholder `aniverse/desktop`, branch `modpack`). Each pack update is one commit that
adds the new objects and replaces `manifest.json`, so players only download the files that changed.
Mods that are on Modrinth keep their `cdn.modrinth.com` urls and are never in the repo.

The app pins the branch to its head commit (`GET api.github.com/repos/<owner>/<repo>/commits/<branch>`) before reading
`raw.githubusercontent.com/<owner>/<repo>/<commit>/manifest.json`, so a push is seen at once instead of after the raw
cache (~5 min). When the API is rate-limited (60 requests per hour per IP) it reads the branch url instead.

## Launchers

| Launcher | Found at (Windows; macOS / Linux equivalents in `launchers/*.js`) | Install |
|---|---|---|
| Minecraft Launcher (`official`) | `%APPDATA%\.minecraft\launcher_profiles.json` (classic and Microsoft Store/Xbox launcher) | Installs `neoforge-<version>` into `.minecraft/versions` by running NeoForge's installer (`--install-client`, needs Java 21: found in the launchers' runtimes, else Mojang's runtime is downloaded to `userData/minecraft/runtime`). Adds a profile `aniverse` with its own game directory `.minecraft/modpacks/aniverse` and `-Xmx6G`. |
| Modrinth App (`modrinth`) | `%APPDATA%\ModrinthApp` | Opens a generated `.mrpack` (Minecraft + loader, no files) with Modrinth App; the player confirms the import there; the new profile is found by its marker, then the files are synced into it. |
| Prism Launcher (`prism`) | `%APPDATA%\PrismLauncher\prismlauncher.cfg` | Writes `instances/Aniverse/` (`instance.cfg`, `mmc-pack.json`, `minecraft/`). Prism downloads Minecraft and NeoForge at first launch. |

When several are installed, `detect()` lists them all and the site asks the player which one to use.

Not supported yet: MultiMC and other portable launchers (no fixed folder), Modrinth App's custom data folder setting,
CurseForge app (it installs into the official launcher's profiles, which is covered).

Not verified yet: installing while the official launcher is open (it may rewrite `launcher_profiles.json` and drop the
new profile until it restarts), and a real Modrinth App import of the generated `.mrpack` (tested with a stand-in).

## Updates

- `install` and `update` run `sync.js`: skip files whose size + sha1 match (sha1 cached by size + mtime in
  `<gameDir>/.aniverse/state.json`), skip `once` files that exist (keybinds in `options.txt`), download the rest in
  parallel (sha1 checked, `.part` + rename), then delete files in `managed_dirs` (`mods`) that the manifest no longer
  lists. Configs that mods generate are never touched.
- A new loader version is applied too: a new `neoforge-*` version + profile for the official launcher, the components in
  `mmc-pack.json` for Prism. Modrinth App's loader cannot be changed from outside: the files are still updated and the
  install reports `needsReinstall`. A new Minecraft version on Modrinth App is refused (`loader-unsupported`).
- Files in use: an install whose game is running (a Java process whose command line contains its game directory) is
  not touched. Automatic updates wait until the game is closed.
- Automatic: 20 s after start and every `CHECK_INTERVAL` (1 h), every install with a new version is updated.

## Site API (`window.aniverseDesktop.minecraft`)

Every call resolves to `{ ok: true, data }` or `{ ok: false, error, message }` (codes below), except `cancel`/`status`.

| Call | data |
|---|---|
| `detect()` | `[{ launcher, name, dataDir, installed: Install \| null }]` |
| `installs()` | `Install[]` |
| `check()` | `{ latest: { version, minecraft, loader, checkedAt }, installs: Install[] }` |
| `install({ launcher, dataDir? })` | `{ install: Install, downloaded, removed, bytes }` (an existing install there is updated instead) |
| `update(installId?, { verify? })` | `{ version, results: [{ installId, ok, version?, downloaded?, removed?, bytes?, upToDate?, needsReinstall?, code?, message? }] }` |
| `launch(installId)` | `{ opened: "game" \| "launcher", launcherName }`: Prism Launcher starts the instance (`--launch <folder>`); Modrinth App and the Minecraft Launcher can only be opened (the latter with the Aniverse profile made the last used, so it is selected). `launcher-not-found` when the launcher's program is not found |
| `cancel()` | `true` when a job was running |
| `status()` | `{ busy, job: { kind, launcher, installId } \| null, latest, lastError }` |

`Install`: `{ installId, launcher, launcherName, dataDir, gameDir, version, minecraft, loader, installedAt, updatedAt,
updateAvailable, needsReinstall }`.

Events (each `on…` returns its unsubscribe function):

- `onProgress(p)`: `{ kind: "install" | "update", launcher, installId, phase, done, total, bytesDone, bytesTotal }`,
  at most ~8 per second. Phases: `resolving`, `java`, `loader`, `waiting-launcher` (Modrinth App import dialog),
  `checking`, `downloading`, `done`.
- `onStatus(status)`: same shape as `status()`, on every job start / end and check.
- `onUpdateRequested({ installId })`, `onUpdateFinished({ ok, … })`: around an update asked by the in-game mod.

Error codes: `offline`, `invalid-manifest`, `update-required`, `hash-mismatch`, `blocked-host`, `disk-full`,
`game-running`, `launcher-not-found`, `loader-unsupported`, `java-not-found`, `loader-failed`, `install-timeout`,
`not-installed`, `busy`, `cancelled`, `forbidden` (not the site's origin), `not-ready`, `unknown`.

## For the in-game update mod

Every managed game directory has `aniverse-modpack.json` at its root (see `marker.js`):

```json
{
  "format": 1,
  "installId": "6f2c…",
  "name": "Aniverse",
  "launcher": "prism",
  "version": "2026.10.15-0015",
  "minecraft": "1.21.1",
  "loader": { "type": "neoforge", "version": "21.1.259" },
  "manifestUrl": "https://raw.githubusercontent.com/aniverse/desktop/modpack/manifest.json",
  "repo": { "owner": "aniverse", "repo": "desktop", "branch": "modpack", "path": "manifest.json" },
  "updateUrl": "aniverse://minecraft/update?install=6f2c…",
  "needsReinstall": false,
  "updatedAt": "2026-10-15T10:00:00.000Z"
}
```

The mod reads it from the game directory, fetches `manifestUrl` (or the commit-pinned url, as above) and compares
`version`. When they differ, it asks the player, opens `updateUrl` (starts the app if needed) and quits the game. The
app waits up to 10 minutes for the game to close, updates, then the player starts the game again.

## Files

| File | Purpose |
|---|---|
| `index.js` | Electron glue: paths, network policy, store, IPC results, automatic updates, deep link |
| `service.js` | detect / install / check / update / cancel (no Electron, injected deps) |
| `manifest.js` | Manifest validation, GitHub branch → commit url |
| `sync.js` | The file sync, lock and sha1 cache |
| `download.js` | One verified download (`.part` + rename, retries), a small pool |
| `net.js` | https-only fetch on allowed hosts, every redirect checked |
| `paths.js` | Safe manifest paths (no absolute, `..`, reserved names; allowed top folders only) |
| `java.js` | Find Java 21 in the launchers' runtimes, or download Mojang's |
| `launchers/*.js` | official, modrinth, prism |
| `marker.js`, `zip.js`, `system.js`, `errors.js` | Marker file, `.mrpack` writer, processes, error codes |

Tests: `bun test tests/minecraft-*.test.js`. Try it for real: `scripts/minecraft-try.js`.
