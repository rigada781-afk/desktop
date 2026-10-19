// ─── Discord Rich Presence ──────────────────────────────────────────────────────
// "Regarde Frieren · Épisode 3" with a "Regarder sur Aniverse" button, gated
// by the app settings (discordRichPresence / discordShowTitle /
// discordShowButton). The IPC path and the express /update-discord-rpc path
// both go through updateDiscordRPC below. Discord not running is not an
// error: the login is retried every 60 s while the presence is enabled.

const config = require("./config");
const DISCORD_APP_ID = config.DISCORD_APP_ID;

const RETRY_MS = 60_000;
const IMAGE_KEY = "logo";
const IMAGE_TEXT = "Aniverse";
const BUTTON_LABEL = "Regarder sur Aniverse";
const HIDDEN_TITLE_DETAILS = "Regarde un anime sur Aniverse";
const MAX_TEXT = 128; // Discord's limit for details / state

function clip(text, max = MAX_TEXT) {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
}

function episodeNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (
    typeof value === "string" &&
    value.trim() &&
    Number.isFinite(Number(value))
  ) {
    return Number(value);
  }
  return null;
}

/**
 * The activity for `{ name, episode, id }`. Without the title, nothing says
 * what is watched: generic details and a button to the site's home.
 */
function buildActivity(
  data,
  { showTitle = true, showButton = true, appUrl = config.APP_URL } = {},
) {
  const name = typeof data?.name === "string" ? data.name.trim() : "";
  const episode = episodeNumber(data?.episode);
  const id =
    typeof data?.id === "string" || typeof data?.id === "number"
      ? String(data.id)
      : "";
  const withTitle = showTitle && !!name;

  const activity = {
    details: withTitle ? clip(`Regarde ${name}`) : HIDDEN_TITLE_DETAILS,
    largeImageKey: IMAGE_KEY,
    largeImageText: IMAGE_TEXT,
    instance: false,
  };
  if (withTitle && episode !== null)
    activity.state = clip(`Épisode ${episode}`);
  if (showButton) {
    const url =
      withTitle && id
        ? `${appUrl}/watch/${encodeURIComponent(id)}${episode !== null ? `?ep=${encodeURIComponent(episode)}` : ""}`
        : appUrl;
    activity.buttons = [{ label: BUTTON_LABEL, url }];
  }
  return activity;
}

/**
 * @param {object} options
 * @param {() => any} options.createClient  a new discord-rpc Client per attempt
 * @param {string} options.clientId
 */
function createDiscordPresence(options) {
  const {
    createClient,
    clientId,
    appUrl = config.APP_URL,
    retryMs = RETRY_MS,
    timers = { setTimeout, clearTimeout },
    logger = console,
  } = options;

  let settings = { enabled: false, showTitle: true, showButton: true };
  let client = null; // the client of the current attempt / connection
  let connected = false;
  let retryTimer = null;
  let lastActivity = null; // the last { name, episode, id } asked for

  function clearRetry() {
    if (retryTimer) timers.clearTimeout(retryTimer);
    retryTimer = null;
  }

  function scheduleRetry() {
    clearRetry();
    if (!settings.enabled) return;
    retryTimer = timers.setTimeout(() => {
      retryTimer = null;
      connect();
    }, retryMs);
    retryTimer?.unref?.();
  }

  function dropClient() {
    const old = client;
    client = null;
    connected = false;
    if (!old) return;
    try {
      Promise.resolve(old.destroy?.()).catch(() => {});
    } catch (_) {}
  }

  async function connect() {
    if (!settings.enabled || client || !clientId) return;
    clearRetry();
    let attempt;
    try {
      attempt = createClient();
    } catch (err) {
      logger.warn("[Discord RPC] unavailable:", err?.message || err);
      scheduleRetry();
      return;
    }
    client = attempt;
    attempt.on?.("disconnected", () => {
      if (client !== attempt) return;
      logger.log("[Discord RPC] Disconnected");
      dropClient();
      scheduleRetry();
    });
    try {
      await attempt.login({ clientId });
    } catch (err) {
      if (client !== attempt) return; // disabled meanwhile
      // Discord not running (or closed during the handshake): try again later.
      logger.log("[Discord RPC] Not connected:", err?.message || err);
      dropClient();
      scheduleRetry();
      return;
    }
    if (client !== attempt) return;
    if (!settings.enabled) {
      dropClient();
      return;
    }
    connected = true;
    logger.log("[Discord RPC] Ready");
    if (lastActivity) await apply(lastActivity);
  }

  async function apply(data) {
    if (!connected || !client)
      return { success: false, error: "not-connected" };
    try {
      const result = await client.setActivity(
        buildActivity(data, { ...settings, appUrl }),
      );
      return { success: true, result };
    } catch (err) {
      logger.warn("[Discord RPC] setActivity failed:", err?.message || err);
      return { success: false, error: "failed" };
    }
  }

  /** Shows `{ name, episode, id }`; remembered and shown once connected. Never throws. */
  async function update(data) {
    // Off: what is watched is never kept, so turning it on later can't show it.
    if (!settings.enabled) {
      lastActivity = null;
      return { success: false, error: "disabled" };
    }
    const ok = data && typeof data === "object";
    // Title hidden when it was watched: it stays hidden if the title is turned on later.
    lastActivity = !ok
      ? null
      : settings.showTitle
        ? { name: data.name, episode: data.episode, id: data.id }
        : { name: "", episode: null, id: "" };
    if (!connected) {
      connect();
      return { success: false, error: "not-connected" };
    }
    return apply(lastActivity);
  }

  /** Never throws. */
  async function clear() {
    lastActivity = null;
    if (!connected || !client) return { success: true };
    try {
      await client.clearActivity();
    } catch (err) {
      logger.warn("[Discord RPC] clearActivity failed:", err?.message || err);
    }
    return { success: true };
  }

  /** Live: off clears the activity and disconnects; on (re)connects. */
  async function configure(next) {
    const previous = settings;
    settings = {
      enabled: next?.enabled !== false,
      showTitle: next?.showTitle !== false,
      showButton: next?.showButton !== false,
    };
    if (!settings.enabled) {
      lastActivity = null;
      clearRetry();
      if (connected && client) {
        try {
          await client.clearActivity();
        } catch (_) {}
      }
      dropClient();
      return;
    }
    if (!client) {
      connect();
      return;
    }
    const shownDiffers =
      previous.showTitle !== settings.showTitle ||
      previous.showButton !== settings.showButton;
    if (connected && lastActivity && shownDiffers) await apply(lastActivity);
  }

  return {
    configure,
    update,
    clear,
    get state() {
      return { ...settings, connected, retrying: !!retryTimer, lastActivity };
    },
  };
}

// ── The app's instance ────────────────────────────────────────────────────────
let registered = false;

function createRealClient() {
  const DiscordRPC = require("discord-rpc");
  if (!registered) {
    registered = true;
    try {
      DiscordRPC.register(DISCORD_APP_ID);
    } catch (_) {}
  }
  return new DiscordRPC.Client({ transport: "ipc" });
}

const presence = createDiscordPresence({
  createClient: createRealClient,
  clientId: DISCORD_APP_ID,
});

/** Applies the settings (and connects when enabled): `{ enabled, showTitle, showButton }`. */
const configureDiscordRPC = (options) => presence.configure(options);

const startDiscordRPC = async (options = { enabled: true }) => {
  if (!DISCORD_APP_ID) {
    console.error("[Discord RPC] DISCORD_APP_ID is not set");
    return;
  }
  await presence.configure(options);
};

const updateDiscordRPC = (data) => presence.update(data);

const clearDiscordRPC = () => presence.clear();

module.exports = {
  startDiscordRPC,
  configureDiscordRPC,
  updateDiscordRPC,
  clearDiscordRPC,
  buildActivity,
  createDiscordPresence,
};
