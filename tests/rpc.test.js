// Discord presence: the French activity, the title / button settings, and
// the connection (gated by the setting, Discord not running → retry every
// 60 s, disconnects, disabling at runtime) against a fake discord-rpc client.
const { describe, test, expect } = require("bun:test");
const { EventEmitter } = require("events");
const { buildActivity, createDiscordPresence } = require("../rpc");

const APP = "https://aniverse.test";
const quiet = { log() {}, error() {}, warn() {}, info() {} };
const tick = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

describe("buildActivity", () => {
  test("French activity with the title, the episode and the button to it", () => {
    expect(buildActivity({ name: "Frieren", episode: 3, id: "abc-1" }, { appUrl: APP })).toEqual({
      details: "Regarde Frieren",
      state: "Épisode 3",
      largeImageKey: "logo",
      largeImageText: "Aniverse",
      instance: false,
      buttons: [{ label: "Regarder sur Aniverse", url: `${APP}/watch/abc-1?ep=3` }],
    });
  });

  test("discordShowTitle off: nothing says what is watched (button to the home page)", () => {
    const activity = buildActivity({ name: "Frieren", episode: 3, id: "abc-1" }, { showTitle: false, appUrl: APP });
    expect(activity.details).toBe("Regarde un anime sur Aniverse");
    expect(activity.state).toBeUndefined();
    expect(activity.buttons).toEqual([{ label: "Regarder sur Aniverse", url: APP }]);
    expect(JSON.stringify(activity)).not.toContain("Frieren");
    expect(JSON.stringify(activity)).not.toContain("abc-1");
  });

  test("discordShowButton off: no buttons", () => {
    expect(buildActivity({ name: "Frieren", episode: 3, id: "x" }, { showButton: false, appUrl: APP }).buttons).toBeUndefined();
  });

  test("odd input: string episode, no episode, no id, long titles, encoded URL", () => {
    expect(buildActivity({ name: "A", episode: "12", id: "x" }, { appUrl: APP }).state).toBe("Épisode 12");
    const noEpisode = buildActivity({ name: "Film", id: "a b" }, { appUrl: APP });
    expect(noEpisode.state).toBeUndefined();
    expect(noEpisode.buttons[0].url).toBe(`${APP}/watch/a%20b`);
    expect(buildActivity({ name: "A", episode: 1 }, { appUrl: APP }).buttons[0].url).toBe(APP);
    const long = buildActivity({ name: "x".repeat(300), episode: 1, id: "i" }, { appUrl: APP });
    expect([...long.details].length).toBe(128);
    expect(long.details.endsWith("…")).toBe(true);
    expect(buildActivity({}, { appUrl: APP }).details).toBe("Regarde un anime sur Aniverse");
    expect(buildActivity(null, { appUrl: APP }).details).toBe("Regarde un anime sur Aniverse");
  });
});

// A discord-rpc Client stand-in: login resolves or rejects as told.
function fakeClients() {
  const made = [];
  let failLogins = 0;
  const factory = () => {
    const client = new EventEmitter();
    client.activities = [];
    client.cleared = 0;
    client.destroyed = false;
    client.login = ({ clientId }) => {
      client.clientId = clientId;
      if (failLogins > 0) {
        failLogins--;
        return Promise.reject(new Error("Could not connect"));
      }
      return Promise.resolve(client);
    };
    client.setActivity = (activity) => {
      client.activities.push(activity);
      return Promise.resolve({ ok: true });
    };
    client.clearActivity = () => {
      client.cleared++;
      return Promise.resolve();
    };
    client.destroy = () => {
      client.destroyed = true;
      return Promise.reject(new TypeError("Cannot read properties of undefined (reading 'write')"));
    };
    made.push(client);
    return client;
  };
  return { made, factory, failNext: (n) => (failLogins = n) };
}

function fakeTimers() {
  const pending = [];
  return {
    pending,
    setTimeout: (fn, ms) => {
      const t = { fn, ms };
      pending.push(t);
      return t;
    },
    clearTimeout: (t) => {
      const i = pending.indexOf(t);
      if (i !== -1) pending.splice(i, 1);
    },
    fireAll() {
      const due = pending.splice(0);
      due.forEach((t) => t.fn());
    },
  };
}

function setup() {
  const clients = fakeClients();
  const timers = fakeTimers();
  const presence = createDiscordPresence({
    createClient: clients.factory,
    clientId: "123",
    appUrl: APP,
    retryMs: 60_000,
    timers,
    logger: quiet,
  });
  return { presence, clients, timers };
}

const episode = { name: "Frieren", episode: 3, id: "abc" };

describe("connection and gating", () => {
  test("disabled: no client, updates refused without throwing", async () => {
    const { presence, clients } = setup();
    await presence.configure({ enabled: false, showTitle: true, showButton: true });
    expect(await presence.update(episode)).toEqual({ success: false, error: "disabled" });
    expect(await presence.clear()).toEqual({ success: true });
    expect(clients.made).toHaveLength(0);
  });

  test("enabled: connects, shows the activity", async () => {
    const { presence, clients } = setup();
    await presence.configure({ enabled: true });
    await tick();
    expect(clients.made).toHaveLength(1);
    expect(clients.made[0].clientId).toBe("123");
    const result = await presence.update(episode);
    expect(result.success).toBe(true);
    expect(clients.made[0].activities.at(-1).details).toBe("Regarde Frieren");
  });

  test("Discord not running: no throw, retry every 60 s while enabled, the last activity shown once connected", async () => {
    const { presence, clients, timers } = setup();
    clients.failNext(2);
    await presence.configure({ enabled: true });
    await tick();
    expect(presence.state.connected).toBe(false);
    expect(timers.pending.map((t) => t.ms)).toEqual([60_000]);
    expect(clients.made[0].destroyed).toBe(true);
    expect(await presence.update(episode)).toEqual({ success: false, error: "not-connected" });
    await tick();
    // the update tried at once (2nd failure), still one retry pending
    expect(clients.made).toHaveLength(2);
    expect(timers.pending).toHaveLength(1);
    timers.fireAll();
    await tick();
    expect(presence.state.connected).toBe(true);
    expect(clients.made).toHaveLength(3);
    expect(clients.made[2].activities).toEqual([buildActivity(episode, { appUrl: APP })]);
    expect(timers.pending).toEqual([]);
  });

  test("turned off: the activity cleared, disconnected, no more retries; on again reconnects", async () => {
    const { presence, clients, timers } = setup();
    await presence.configure({ enabled: true });
    await tick();
    await presence.update(episode);
    await presence.configure({ enabled: false });
    expect(clients.made[0].cleared).toBe(1);
    expect(clients.made[0].destroyed).toBe(true);
    expect(presence.state.connected).toBe(false);
    expect(timers.pending).toEqual([]);

    // a failing one being retried stops too
    clients.failNext(1);
    await presence.configure({ enabled: true });
    await tick();
    expect(timers.pending).toHaveLength(1);
    await presence.configure({ enabled: false });
    expect(timers.pending).toEqual([]);

    await presence.configure({ enabled: true });
    await tick();
    expect(presence.state.connected).toBe(true);
    // turning it off forgot what was shown: nothing old comes back
    expect(clients.made.at(-1).activities).toEqual([]);
  });

  test("privacy: what is watched while it's off is never shown when it's turned on", async () => {
    const { presence, clients } = setup();
    await presence.configure({ enabled: false });
    await presence.update({ name: "Secret Title", episode: 7, id: "secret" });
    expect(presence.state.lastActivity).toBeNull();
    await presence.configure({ enabled: true });
    await tick();
    expect(presence.state.connected).toBe(true);
    expect(clients.made.at(-1).activities).toEqual([]);
  });

  test("privacy: a title hidden when watched stays hidden when the title is turned back on", async () => {
    const { presence, clients } = setup();
    await presence.configure({ enabled: true, showTitle: false });
    await tick();
    await presence.update({ name: "Secret Title", episode: 7, id: "secret" });
    await presence.configure({ enabled: true, showTitle: true });
    const shown = clients.made[0].activities.map((a) => JSON.stringify(a));
    expect(shown.some((a) => a.includes("Secret"))).toBe(false);
    expect(clients.made[0].activities.at(-1).details).toBe("Regarde un anime sur Aniverse");
  });

  test("showTitle / showButton changed while connected: the activity is redrawn", async () => {
    const { presence, clients } = setup();
    await presence.configure({ enabled: true });
    await tick();
    await presence.update(episode);
    await presence.configure({ enabled: true, showTitle: false, showButton: false });
    const last = clients.made[0].activities.at(-1);
    expect(last.details).toBe("Regarde un anime sur Aniverse");
    expect(last.buttons).toBeUndefined();
    // same options again: no redraw
    const count = clients.made[0].activities.length;
    await presence.configure({ enabled: true, showTitle: false, showButton: false });
    expect(clients.made[0].activities.length).toBe(count);
  });

  test("Discord closing: disconnected → retry", async () => {
    const { presence, clients, timers } = setup();
    await presence.configure({ enabled: true });
    await tick();
    clients.made[0].emit("disconnected");
    expect(presence.state.connected).toBe(false);
    expect(timers.pending).toHaveLength(1);
    timers.fireAll();
    await tick();
    expect(presence.state.connected).toBe(true);
    expect(clients.made).toHaveLength(2);
  });

  test("disabled during the login: the late client is dropped", async () => {
    const { presence, clients } = setup();
    presence.configure({ enabled: true }); // login pending
    await presence.configure({ enabled: false });
    await tick();
    expect(presence.state.connected).toBe(false);
    expect(clients.made[0].destroyed).toBe(true);
  });

  test("setActivity / clearActivity failures never throw", async () => {
    const { presence, clients } = setup();
    await presence.configure({ enabled: true });
    await tick();
    clients.made[0].setActivity = () => Promise.reject(new Error("RPC_CONNECTION_TIMEOUT"));
    clients.made[0].clearActivity = () => Promise.reject(new Error("closed"));
    expect(await presence.update(episode)).toEqual({ success: false, error: "failed" });
    expect(await presence.clear()).toEqual({ success: true });
  });

  test("clear: forgets the activity (not shown again on reconnect)", async () => {
    const { presence, clients } = setup();
    await presence.configure({ enabled: true });
    await tick();
    await presence.update(episode);
    await presence.clear();
    expect(clients.made[0].cleared).toBe(1);
    await presence.configure({ enabled: false });
    await presence.configure({ enabled: true });
    await tick();
    expect(clients.made[1].activities).toEqual([]);
  });
});
