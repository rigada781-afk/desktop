// ─── Aniverse Desktop App Configuration ────────────────────────────────────────
// Edit this file to change core app settings.

module.exports = {
  // The URL the Electron window will load
  APP_URL: process.argv.includes("--loc")
    ? "http://localhost:3030"
    : "https://aniverse.fr",

  // App version (synced from package.json automatically)
  // This is used in the User-Agent header
  // User-Agent format: AniverseDesktop/{version} ...

  // Custom header injected into every web request
  CUSTOM_HEADER_NAME: "x-app",
  CUSTOM_HEADER_VALUE: "desktop",

  // Express background server port
  // This runs at startup (even before the main window opens)
  EXPRESS_PORT: 57331,

  // Windows AppUserModelID: notifications show under the installer's shortcut,
  // which carries package.json's build.appId (tests/config.test.js keeps them
  // equal). Not read from package.json: electron-builder strips "build" from
  // the packaged copy.
  APP_USER_MODEL_ID: "com.aniverse.desktop",

  // Deep link protocol
  // e.g. aniverse://open?page=dashboard
  DEEP_LINK_PROTOCOL: "aniverse",

  // Proxy config
  // All requests from the site are proxied through Express to bypass CORS
  PROXY_TARGET: "https://aniverse.fr",

  // Auto-updater
  // Set to false to disable auto-updates
  AUTO_UPDATE: true,

  // Check for updates every X milliseconds (default: 4 hours)
  UPDATE_CHECK_INTERVAL: 4 * 60 * 60 * 1000,

  // Discord RPC
  // Not a secret (Discord shows it in every presence): written here so dev
  // runs and installed builds have it; the environment can still override it.
  DISCORD_APP_ID: process.env.DISCORD_APP_ID || "1556045351608131614",

  // Minecraft modpack (minecraft/): the pack tool's out/client/ folder
  // (manifest.json + objects/) published on a branch of a public GitHub repo.
  // Placeholder until the repo exists. ANIVERSE_MODPACK_URL (dev builds only)
  // points at another manifest, e.g. a local folder served over http.
  MINECRAFT: {
    REPO: {
      owner: "rigada781-afk",
      repo: "desktop",
      branch: "modpack",
      path: "manifest.json",
    },
    MANIFEST_URL: null,
    INSTANCE_NAME: "Aniverse",
    // Java heap for new installs (official launcher profile, Prism instance)
    MEMORY_MB: 6656,
    CHECK_INTERVAL: 60 * 60 * 1000,
  },

  // Window settings
  WINDOW: {
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: "Aniverse",
  },

  server: true,
};
