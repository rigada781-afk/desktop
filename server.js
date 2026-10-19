const express = require("express");
const cors = require("cors");
const { request: httpsRequest } = require("https");
const { request: httpRequest } = require("http");
const config = require("./config");
const { updateDiscordRPC, clearDiscordRPC } = require("./rpc");

let mainWindowRef = null; // Set by main process after window is created
let goToPathRef = null; // Set by main process after window is created

function setMainWindow(win, goToPath) {
  mainWindowRef = win;
  goToPathRef = goToPath;
}

function createExpressServer(appVersion) {
  const app = express();

  // ── CORS: allow everything ──────────────────────────────────────────────────
  app.use(
    cors({
      origin: "*",
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"],
      allowedHeaders: "*", // allow any request header
      exposedHeaders: "*", // expose any response header
      credentials: true,
      preflightContinue: false,
      optionsSuccessStatus: 204,
    }),
  );

  // Allow all preflight requests globally
  app.options("*", cors());

  // ── Parse JSON bodies ───────────────────────────────────────────────────────
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // ── /ping ── website uses this to detect if desktop app is installed ────────
  app.get("/ping", (req, res) => {
    res.json({
      installed: true,
      app: "aniverse-desktop",
      version: appVersion,
      platform: process.platform,
    });
  });

  // ── /open ── open the main window (used by deep links / website button) ─────
  app.get("/open", (req, res) => {
    goToPathRef(req.query.path);
    res.json({ success: true });
  });

  // ── /update-discord-rpc ── update the discord RPC ───────────────────────────
  // The Discord routes change the user's profile: only the site may call
  // them. Any other website could post a form here (a form needs no CORS
  // preflight), so the Origin must be the site's, and the update JSON.
  const fromSite = (req) => req.get("origin") === new URL(config.APP_URL).origin;

  app.post("/update-discord-rpc", async (req, res) => {
    if (!fromSite(req) || !req.is("application/json")) {
      return res.status(403).json({ success: false, error: "forbidden" });
    }
    const { name, episode, id } = req.body;
    const result = await updateDiscordRPC({ name, episode, id });
    res.json(result);
  });

  app.post("/clear-discord-rpc", async (req, res) => {
    if (!fromSite(req)) return res.status(403).json({ success: false, error: "forbidden" });
    await clearDiscordRPC();
    res.json({ success: true });
  });

  // ── /proxy ── simple pipe proxy: ?url=...&headers=...&method=... ─────────
  app.get("/proxy", (req, res) => {
    const target = req.query.url;
    if (!target) return res.status(400).json({ error: "Missing url param" });

    const method = req.query.method || "GET";
    let headers = {};

    if (req.query.headers) {
      try {
        headers = JSON.parse(decodeURIComponent(req.query.headers));
      } catch {
        return res.status(400).json({ error: "Invalid headers JSON" });
      }
    }

    const url = new URL(target);
    const client = url.protocol === "https:" ? httpsRequest : httpRequest;

    const proxy = client(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + url.search,
        method,
        headers,
      },
      (upstream) => {
        res.status(upstream.statusCode || 500).set(upstream.headers);
        upstream.pipe(res);
      },
    );

    proxy.on("error", (err) => {
      res.status(502).json({ error: "Proxy error", message: err.message });
    });
    proxy.end();
  });

  // ── 404 fallback ─────────────────────────────────────────────────────────────
  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  return app;
}

function buildUserAgent(version) {
  const platform =
    process.platform === "win32"
      ? "Windows"
      : process.platform === "darwin"
        ? "Macintosh"
        : "Linux";
  return `AniverseDesktop/${version} (${platform}) Electron`;
}

function buildExtraHeaders(version) {
  return [
    `${config.CUSTOM_HEADER_NAME}: ${config.CUSTOM_HEADER_VALUE}`,
    `User-Agent: ${buildUserAgent(version)}`,
  ].join("\n");
}

function startExpressServer(appVersion) {
  return new Promise((resolve, reject) => {
    if (!config.server) {
      console.log("[express] Server is disabled in config — skipping startup");
      return resolve(null);
    }

    const app = createExpressServer(appVersion);
    const server = app.listen(config.EXPRESS_PORT, "127.0.0.1", () => {
      console.log(
        `[express] Aniverse background server running on http://127.0.0.1:${config.EXPRESS_PORT}`,
      );
      resolve(server);
    });
    server.on("error", (err) => {
      if (err.code === "EADDRINUSE") {
        console.warn(
          `[express] Port ${config.EXPRESS_PORT} already in use — skipping server start`,
        );
        resolve(null); // Already running — that's fine
      } else {
        reject(err);
      }
    });
  });
}

module.exports = {
  startExpressServer,
  setMainWindow,
  buildUserAgent,
  buildExtraHeaders,
};
