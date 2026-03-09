// ─── Vumeto Desktop App Configuration ────────────────────────────────────────
// Edit this file to change core app settings.

module.exports = {
  // The URL the Electron window will load
  APP_URL: "https://beta.vumeto.com",

  // App version (synced from package.json automatically)
  // This is used in the User-Agent header
  // User-Agent format: VumetoDesktop/{version} ...

  // Custom header injected into every web request
  CUSTOM_HEADER_NAME: "x-app",
  CUSTOM_HEADER_VALUE: "desktop",

  // Express background server port
  // This runs at startup (even before the main window opens)
  EXPRESS_PORT: 57331,

  // Deep link protocol
  // e.g. vumeto://open?page=dashboard
  DEEP_LINK_PROTOCOL: "vumeto",

  // Proxy config
  // All requests from the site are proxied through Express to bypass CORS
  PROXY_TARGET: "https://beta.vumeto.com",

  // Auto-updater
  // Set to false to disable auto-updates
  AUTO_UPDATE: true,

  // Check for updates every X milliseconds (default: 4 hours)
  UPDATE_CHECK_INTERVAL: 4 * 60 * 60 * 1000,

  // Window settings
  WINDOW: {
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: "Vumeto",
  },
};
