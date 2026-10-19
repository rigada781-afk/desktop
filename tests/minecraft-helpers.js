// Shared helpers for the Minecraft modpack tests: a local HTTP server that
// serves in-memory files (and can corrupt them), temp folders, a published
// pack laid out like the pack tool's out/client/.

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const sha1 = (b) => crypto.createHash("sha1").update(b).digest("hex");

async function startServer() {
  const routes = new Map();
  const log = [];
  const server = http.createServer((req, res) => {
    const p = new URL(req.url, "http://x").pathname;
    log.push({ method: req.method, path: p });
    const r = routes.get(p);
    if (!r) return res.writeHead(404).end("not found");
    if (r.redirectTo) return res.writeHead(302, { location: r.redirectTo }).end();
    const body = r.serveBody || r.body;
    res.writeHead(200, { "content-length": String(body.length) });
    res.end(req.method === "HEAD" ? undefined : body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    routes,
    log,
    set(p, route) {
      routes.set(p, Buffer.isBuffer(route) || typeof route === "string" ? { body: Buffer.from(route) } : route);
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

function tempDir(prefix = "aniv-mc-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }) };
}

/**
 * Publishes files under /pack/ like out/client/ (objects/<aa>/<sha1>, or an absolute path for "Modrinth" files)
 * and returns the raw manifest object.
 */
function publish(srv, files, version, extra = {}) {
  const raw = {
    format: 1,
    name: "Aniverse",
    version,
    minecraft: "1.21.1",
    loader: { type: "neoforge", version: "21.1.259" },
    managed_dirs: ["mods"],
    files: files.map((f) => {
      const h = sha1(f.body);
      const url = f.absolute ? `${srv.url}${f.absolute}` : `objects/${h.slice(0, 2)}/${h}`;
      srv.set(f.absolute || `/pack/objects/${h.slice(0, 2)}/${h}`, f.body);
      return { path: f.path, sha1: h, size: f.body.length, mode: f.mode || "sync", url };
    }),
    ...extra,
  };
  srv.set("/pack/manifest.json", JSON.stringify(raw));
  return raw;
}

/** Reads a stored (uncompressed) zip: [{ name, data }]. */
function readStoredZip(buf) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let off = buf.readUInt32LE(end + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    const nameLen = buf.readUInt16LE(off + 28);
    const local = buf.readUInt32LE(off + 42);
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString("utf8");
    const size = buf.readUInt32LE(local + 18);
    const localName = buf.readUInt16LE(local + 26);
    const data = buf.subarray(local + 30 + localName, local + 30 + localName + size);
    out.push({ name, data, crc: buf.readUInt32LE(off + 16), method: buf.readUInt16LE(local + 8) });
    off += 46 + nameLen;
  }
  return out;
}

module.exports = { sha1, startServer, tempDir, publish, readStoredZip };
