const { describe, test, expect, beforeEach, afterEach } = require("bun:test");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { parseManifest, resolveFileUrl, resolveManifestUrl, branchManifestUrl } = require("../minecraft/manifest");
const { createFetch, checkUrl } = require("../minecraft/net");
const { syncPack, readState } = require("../minecraft/sync");
const { createZip, crc32 } = require("../minecraft/zip");
const { sha1, startServer, tempDir, publish, readStoredZip } = require("./minecraft-helpers");

const local = createFetch({ hosts: new Set(), allowLoopbackHttp: true });
const fast = { attempts: 2, backoffMs: () => 5 };
let srv;
let tmp;
let gameDir;

beforeEach(async () => {
  srv = await startServer();
  tmp = tempDir();
  gameDir = path.join(tmp.dir, "game");
});
afterEach(async () => {
  await srv.close();
  tmp.cleanup();
});

const manifestUrl = () => `${srv.url}/pack/manifest.json`;
const parsed = (raw) => parseManifest(JSON.stringify(raw));
const opts = (manifest, more = {}) => ({
  gameDir,
  manifest,
  resolveUrl: (u) => resolveFileUrl(manifestUrl(), u),
  fetch: local,
  download: fast,
  ...more,
});
const file = (rel) => path.join(gameDir, ...rel.split("/"));
const read = (rel) => fs.readFileSync(file(rel));
const has = (rel) => fs.existsSync(file(rel));
const put = (rel, body) => {
  fs.mkdirSync(path.dirname(file(rel)), { recursive: true });
  fs.writeFileSync(file(rel), body);
};
const fileRequests = () => srv.log.filter((l) => l.path !== "/pack/manifest.json").length;

describe("manifest", () => {
  const base = (files, extra = {}) =>
    JSON.stringify({ format: 1, version: "1", minecraft: "1.21.1", loader: { type: "neoforge", version: "21.1.259" }, managed_dirs: ["mods"], files, ...extra });
  const f = (p) => ({ path: p, sha1: "a".repeat(40), size: 1, mode: "sync", url: "objects/aa/x" });

  test("accepts the pack tool format and normalizes paths", () => {
    const m = parseManifest(base([f("mods/a.jar"), { ...f("options.txt"), mode: "once" }, f("config\\sub\\b.toml")]));
    expect(m.files.map((x) => x.path)).toEqual(["mods/a.jar", "options.txt", "config/sub/b.toml"]);
    expect(m.files[1].mode).toBe("once");
    expect(m.loader).toEqual({ type: "neoforge", version: "21.1.259" });
  });

  test.each([
    ["/etc/passwd"],
    ["C:/Windows/x.dll"],
    ["\\\\server\\share\\x"],
    ["mods/../../x.jar"],
    ["../options.txt"],
    ["saves/world/level.dat"],
    ["config/con.txt"],
    ["mods"],
  ])("refuses %p and the whole manifest with it", (p) => {
    expect(() => parseManifest(base([f("mods/ok.jar"), f(p)]))).toThrow(expect.objectContaining({ code: "invalid-manifest" }));
  });

  test("refuses case-only duplicates and unsafe managed dirs", () => {
    expect(() => parseManifest(base([f("mods/A.jar"), f("mods/a.jar")]))).toThrow(expect.objectContaining({ code: "invalid-manifest" }));
    for (const dir of ["saves", ".", "", "options.txt", "../mods", "/mods"]) {
      expect(() => parseManifest(base([], { managed_dirs: [dir] }))).toThrow(expect.objectContaining({ code: "invalid-manifest" }));
    }
  });

  test("newer formats ask for an app update; junk is refused", () => {
    expect(() => parseManifest(base([], { format: 2 }))).toThrow(expect.objectContaining({ code: "update-required" }));
    expect(() => parseManifest("<html>")).toThrow(expect.objectContaining({ code: "invalid-manifest" }));
    expect(() => parseManifest(base([{ ...f("mods/a.jar"), sha1: "nope" }]))).toThrow(expect.objectContaining({ code: "invalid-manifest" }));
  });

  test("relative urls resolve next to the manifest; absolute ones stay", () => {
    const at = "https://raw.githubusercontent.com/o/r/abc123/manifest.json";
    expect(resolveFileUrl(at, "objects/ab/ab12")).toBe("https://raw.githubusercontent.com/o/r/abc123/objects/ab/ab12");
    expect(resolveFileUrl(at, "https://cdn.modrinth.com/data/x/y.jar")).toBe("https://cdn.modrinth.com/data/x/y.jar");
  });

  test("the branch is pinned to its head commit, or used as is when GitHub's API fails", async () => {
    const source = { repo: { owner: "o", repo: "r", branch: "modpack", path: "manifest.json" } };
    const sha = "b".repeat(40);
    const calls = [];
    const ok = async (u, init) => {
      calls.push({ u, accept: init.headers.accept });
      return new Response(sha, { status: 200 });
    };
    expect(await resolveManifestUrl(source, { fetchImpl: ok })).toBe(`https://raw.githubusercontent.com/o/r/${sha}/manifest.json`);
    expect(calls[0]).toEqual({ u: "https://api.github.com/repos/o/r/commits/modpack", accept: "application/vnd.github.sha" });
    const limited = async () => new Response('{"message":"API rate limit exceeded"}', { status: 403 });
    expect(await resolveManifestUrl(source, { fetchImpl: limited })).toBe("https://raw.githubusercontent.com/o/r/modpack/manifest.json");
    expect(branchManifestUrl(source)).toBe("https://raw.githubusercontent.com/o/r/modpack/manifest.json");
  });
});

describe("network policy", () => {
  test("https on allowed hosts only; loopback http only when allowed", () => {
    const policy = { hosts: new Set(["cdn.modrinth.com"]) };
    expect(checkUrl("https://cdn.modrinth.com/x", policy).host).toBe("cdn.modrinth.com");
    for (const u of ["http://cdn.modrinth.com/x", "https://evil.example/x", "http://127.0.0.1/x", "https://u:p@cdn.modrinth.com/x"]) {
      expect(() => checkUrl(u, policy)).toThrow(expect.objectContaining({ code: "blocked-host" }));
    }
    expect(checkUrl("http://127.0.0.1:8080/x", { ...policy, allowLoopbackHttp: true }).port).toBe("8080");
  });

  test("every redirect hop is checked", async () => {
    srv.set("/hop", { redirectTo: "http://192.168.1.1/admin" });
    await expect(local(`${srv.url}/hop`)).rejects.toMatchObject({ code: "blocked-host" });
  });
});

describe("sync", () => {
  test("fresh install verifies every file, then a second run downloads nothing", async () => {
    const files = [
      { path: "mods/create.jar", body: crypto.randomBytes(300_000), absolute: "/data/create/create.jar" },
      { path: "mods/local.jar", body: crypto.randomBytes(5000) },
      { path: "config/a.toml", body: Buffer.from("a = 1\n") },
      { path: "config/sub/empty.json", body: Buffer.alloc(0) },
      { path: "options.txt", body: Buffer.from("key_key.jump:key.keyboard.space\n"), mode: "once" },
    ];
    const m = parsed(publish(srv, files, "1"));
    const progress = [];
    const r1 = await syncPack(opts(m, { onProgress: (p) => progress.push(p) }));
    expect(r1.downloaded).toEqual(files.map((f) => f.path).sort());
    for (const f of files) expect(sha1(read(f.path))).toBe(sha1(f.body));
    expect(progress[0].phase).toBe("checking");
    const last = progress.filter((p) => p.phase === "downloading").at(-1);
    expect(last).toMatchObject({ done: files.length, total: files.length, bytesDone: last.bytesTotal });
    expect((await readState(gameDir)).version).toBe("1");
    expect(fs.existsSync(path.join(gameDir, ".aniverse", "downloads"))).toBe(false);
    expect(fs.existsSync(path.join(gameDir, ".aniverse", "lock"))).toBe(false);

    const before = fileRequests();
    expect((await syncPack(opts(m))).downloaded).toEqual([]);
    expect((await syncPack(opts(m, { fullVerify: true }))).downloaded).toEqual([]);
    expect(fileRequests()).toBe(before);
  });

  test("incremental update: changed files only, managed dirs cleaned, player files kept", async () => {
    const keep = crypto.randomBytes(4000);
    const v1 = parsed(
      publish(
        srv,
        [
          { path: "mods/keep.jar", body: keep },
          { path: "mods/old-1.0.jar", body: crypto.randomBytes(3000) },
          { path: "mods/removed.jar", body: crypto.randomBytes(2000) },
          { path: "config/mod.toml", body: Buffer.from("v = 1\n") },
          { path: "options.txt", body: Buffer.from("defaults v1\n"), mode: "once" },
        ],
        "1",
      ),
    );
    await syncPack(opts(v1));
    put("options.txt", "my keybinds\n");
    put("mods/my-own-mod.jar", "x");
    put("mods/sub/nested.jar", "y");
    put("config/generated-by-a-mod.toml", "g = 1\n");

    const newMod = crypto.randomBytes(3500);
    const v2 = parsed(
      publish(
        srv,
        [
          { path: "mods/keep.jar", body: keep },
          { path: "mods/old-2.0.jar", body: newMod },
          { path: "config/mod.toml", body: Buffer.from("v = 2\n") },
          { path: "options.txt", body: Buffer.from("defaults v2\n"), mode: "once" },
        ],
        "2",
      ),
    );
    const before = fileRequests();
    const r = await syncPack(opts(v2));
    expect(r.downloaded).toEqual(["config/mod.toml", "mods/old-2.0.jar"]);
    expect(fileRequests() - before).toBe(2);
    expect(r.removed).toEqual(["mods/my-own-mod.jar", "mods/old-1.0.jar", "mods/removed.jar", "mods/sub/nested.jar"]);
    expect(read("mods/old-2.0.jar")).toEqual(newMod);
    expect(read("options.txt").toString()).toBe("my keybinds\n");
    expect(has("config/generated-by-a-mod.toml")).toBe(true);
  });

  test("restores a deleted once file; repairs a corrupted file (cache trusted until mtime or verify)", async () => {
    const jar = crypto.randomBytes(6000);
    const m = parsed(publish(srv, [{ path: "mods/a.jar", body: jar }, { path: "options.txt", body: Buffer.from("d\n"), mode: "once" }], "1"));
    await syncPack(opts(m));
    fs.rmSync(file("options.txt"));
    expect((await syncPack(opts(m))).downloaded).toEqual(["options.txt"]);

    const st = fs.statSync(file("mods/a.jar"));
    const bad = Buffer.from(jar);
    bad[0] ^= 0xff;
    fs.writeFileSync(file("mods/a.jar"), bad);
    fs.utimesSync(file("mods/a.jar"), st.atime, st.mtime);
    expect((await syncPack(opts(m))).downloaded).toEqual([]);
    expect((await syncPack(opts(m, { fullVerify: true }))).downloaded).toEqual(["mods/a.jar"]);
    expect(read("mods/a.jar")).toEqual(jar);

    fs.writeFileSync(file("mods/a.jar"), bad);
    fs.utimesSync(file("mods/a.jar"), new Date(), new Date(Date.now() + 5000));
    expect((await syncPack(opts(m))).downloaded).toEqual(["mods/a.jar"]);
  });

  test("a sha1 mismatch fails without touching the installed file", async () => {
    const good = crypto.randomBytes(1000);
    const m = parsed(publish(srv, [{ path: "mods/a.jar", body: good }], "1"));
    put("mods/a.jar", "previous version");
    const h = sha1(good);
    srv.set(`/pack/objects/${h.slice(0, 2)}/${h}`, { body: good, serveBody: crypto.randomBytes(1000) });
    await expect(syncPack(opts(m))).rejects.toMatchObject({ code: "hash-mismatch" });
    expect(read("mods/a.jar").toString()).toBe("previous version");
    expect(await readState(gameDir)).toBeNull();
  });

  test("hosts outside the policy are refused", async () => {
    const m = parsed({
      format: 1,
      version: "1",
      minecraft: "1.21.1",
      loader: { type: "neoforge", version: "21.1.259" },
      files: [{ path: "mods/evil.jar", sha1: "a".repeat(40), size: 3, url: "https://evil.example/evil.jar" }],
    });
    const strict = createFetch({ hosts: new Set(["cdn.modrinth.com"]) });
    await expect(syncPack(opts(m, { fetch: strict }))).rejects.toMatchObject({ code: "blocked-host" });
    expect(has("mods/evil.jar")).toBe(false);
  });

  test("disk-full is reported before downloading; abort stops, the next run completes", async () => {
    const m = parsed(publish(srv, [{ path: "mods/a.jar", body: crypto.randomBytes(1000) }], "1"));
    await expect(syncPack(opts(m, { freeBytes: async () => 10 }))).rejects.toMatchObject({ code: "disk-full" });
    expect(fileRequests()).toBe(0);
    const ac = new AbortController();
    ac.abort(new DOMException("stopped", "AbortError"));
    await expect(syncPack(opts(m, { signal: ac.signal }))).rejects.toMatchObject({ name: "AbortError" });
    expect((await syncPack(opts(m))).downloaded).toEqual(["mods/a.jar"]);
  });

  test("a second writer on the same game directory is refused", async () => {
    const m = parsed(publish(srv, [{ path: "mods/a.jar", body: crypto.randomBytes(200_000) }], "1"));
    const first = syncPack(opts(m));
    await new Promise((r) => setTimeout(r, 5));
    await expect(syncPack(opts(m))).rejects.toMatchObject({ code: "busy" });
    await first;
  });
});

describe("zip", () => {
  test("crc32 and a readable stored zip", () => {
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
    const zip = createZip([
      { name: "modrinth.index.json", data: '{"a":1}' },
      { name: "overrides/aniverse-modpack.json", data: Buffer.from("{}") },
    ]);
    const entries = readStoredZip(zip);
    expect(entries.map((e) => [e.name, e.data.toString(), e.method])).toEqual([
      ["modrinth.index.json", '{"a":1}', 0],
      ["overrides/aniverse-modpack.json", "{}", 0],
    ]);
    for (const e of entries) expect(e.crc).toBe(crc32(e.data));
  });
});
