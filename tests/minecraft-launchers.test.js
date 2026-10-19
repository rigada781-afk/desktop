const { describe, test, expect, beforeEach, afterEach } = require("bun:test");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { createFetch } = require("../minecraft/net");
const { createModpackService } = require("../minecraft/service");
const { systemEnv, isGameRunning } = require("../minecraft/system");
const { parseJavaMajor, requiredJavaMajor, mojangPlatform, findJava } = require("../minecraft/java");
const { readMarker } = require("../minecraft/marker");
const official = require("../minecraft/launchers/official");
const modrinth = require("../minecraft/launchers/modrinth");
const prism = require("../minecraft/launchers/prism");
const { sha1, startServer, tempDir, publish, readStoredZip } = require("./minecraft-helpers");

let srv;
let tmp;
let sys;
const local = createFetch({ hosts: new Set(), allowLoopbackHttp: true });

beforeEach(async () => {
  srv = await startServer();
  tmp = tempDir();
  sys = systemEnv({
    platform: "win32",
    home: tmp.dir,
    env: { APPDATA: path.join(tmp.dir, "Roaming"), LOCALAPPDATA: path.join(tmp.dir, "Local") },
  });
});
afterEach(async () => {
  await srv.close();
  tmp.cleanup();
});

const roaming = (...p) => path.join(tmp.dir, "Roaming", ...p);
const write = (file, body) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
};
const json = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

// The official launcher's absolute URLs (NeoForge's Maven) are served by the local server under /maven.
const testFetch = (u, init) => {
  const url = new URL(u);
  if (url.hostname === "maven.neoforged.net") return local(`${srv.url}/maven${url.pathname}`, init);
  return local(u, init);
};

function service(more = {}) {
  let records = [];
  const events = [];
  const s = createModpackService({
    source: { manifestUrl: `${srv.url}/pack/manifest.json` },
    sys,
    launchers: { official, modrinth, prism },
    guardedFetch: testFetch,
    store: { get: () => records, set: (v) => (records = v) },
    openFile: async () => "no app",
    runImpl: async () => ({ code: 1, stdout: "", stderr: "" }),
    isGameRunning: async () => false,
    ensureJava: async () => "/fake/java",
    tmpDir: path.join(tmp.dir, "tmp"),
    newId: () => crypto.randomUUID(),
    downloadOptions: { attempts: 1 },
    options: { gamePollMs: 10 },
    onProgress: (p) => events.push(p),
    ...more,
  });
  return { s, events, records: () => records, clearStore: () => (records = []) };
}

// The same files for the whole test (a new version adds or changes files on top of them).
let base = [];
beforeEach(() => {
  base = [
    { path: "mods/a.jar", body: crypto.randomBytes(3000) },
    { path: "config/a.toml", body: Buffer.from("a = 1\n") },
    { path: "options.txt", body: Buffer.from("keys\n"), mode: "once" },
  ];
});
const packFiles = () => base;

describe("helpers", () => {
  test("java versions", () => {
    expect(parseJavaMajor('openjdk version "21.0.8" 2025-07-15 LTS')).toBe(21);
    expect(parseJavaMajor('java version "1.8.0_51"')).toBe(8);
    expect(parseJavaMajor("nope")).toBeNull();
    expect(requiredJavaMajor("1.21.1")).toBe(21);
    expect(requiredJavaMajor("1.20.4")).toBe(17);
    expect(requiredJavaMajor("1.20.5")).toBe(21);
    expect(requiredJavaMajor("1.12.2")).toBe(8);
    expect(requiredJavaMajor("26.3")).toBe(25);
    expect(mojangPlatform("win32", "x64")).toBe("windows-x64");
    expect(mojangPlatform("darwin", "arm64")).toBe("mac-os-arm64");
    expect(mojangPlatform("linux", "arm64")).toBeNull();
  });

  test("finds a launcher's Java 21, skipping older ones", async () => {
    const old = path.join(roaming(".minecraft", "runtime", "jre-legacy", "bin", "java.exe"));
    const modern = roaming("ModrinthApp", "meta", "java_versions", "zulu21", "bin", "java.exe");
    write(old, "");
    write(modern, "");
    const runImpl = async (bin) => ({
      code: 0,
      stdout: "",
      stderr: bin === old ? 'java version "1.8.0_51"' : 'openjdk version "21.0.8"',
    });
    expect(await findJava(sys, { minMajor: 21, runImpl })).toEqual({ path: modern, major: 21 });
    expect(await findJava(sys, { minMajor: 25, runImpl: async () => ({ code: 1, stdout: "", stderr: "" }) })).toBeNull();
  });

  test("a running game is found by its game directory in Java command lines", async () => {
    const gameDir = "C:\\Users\\x\\AppData\\Roaming\\.minecraft\\modpacks\\aniverse";
    const runImpl = async () => ({
      code: 0,
      stdout: `"C:\\java\\javaw.exe" -Xmx6G net.minecraft.client.main.Main --gameDir C:\\Users\\X\\AppData\\Roaming\\.minecraft\\modpacks\\aniverse --width 854\r\n`,
      stderr: "",
    });
    expect(await isGameRunning(gameDir, { platform: "win32", runImpl })).toBe(true);
    expect(await isGameRunning("C:\\other", { platform: "win32", runImpl })).toBe(false);
  });
});

describe("Prism Launcher", () => {
  beforeEach(() => write(roaming("PrismLauncher", "prismlauncher.cfg"), "InstanceDir=instances\nLanguage=fr\n"));

  test("installs an instance, then updates it (loader change included)", async () => {
    publish(srv, packFiles(), "1");
    const { s, events } = service();
    const found = await s.detect();
    expect(found).toEqual([{ launcher: "prism", name: "Prism Launcher", dataDir: roaming("PrismLauncher"), installed: null }]);

    const r = await s.install({ launcher: "prism" });
    const inst = roaming("PrismLauncher", "instances", "Aniverse");
    expect(r.install).toMatchObject({ launcher: "prism", gameDir: path.join(inst, "minecraft"), version: "1", updateAvailable: false });
    expect(fs.readFileSync(path.join(inst, "instance.cfg"), "utf8")).toContain("MaxMemAlloc=6144");
    expect(json(path.join(inst, "mmc-pack.json")).components).toEqual([
      { important: true, uid: "net.minecraft", version: "1.21.1" },
      { uid: "net.neoforged", version: "21.1.259" },
    ]);
    expect(fs.existsSync(path.join(inst, "minecraft", "mods", "a.jar"))).toBe(true);
    const marker = await readMarker(path.join(inst, "minecraft"));
    expect(marker).toMatchObject({ installId: r.install.installId, launcher: "prism", version: "1", minecraft: "1.21.1" });
    expect(marker.updateUrl).toBe(`aniverse://minecraft/update?install=${r.install.installId}`);
    expect(events.map((e) => e.phase)).toContain("downloading");
    expect(events.at(-1)).toMatchObject({ kind: "install", phase: "done" });

    // The player adds a component (e.g. an LWJGL override): it survives the loader update.
    const packFile = path.join(inst, "mmc-pack.json");
    write(packFile, JSON.stringify({ formatVersion: 1, components: [...json(packFile).components, { uid: "org.lwjgl3", version: "3.3.3" }] }));
    publish(srv, [...packFiles(), { path: "mods/b.jar", body: crypto.randomBytes(100) }], "2", { loader: { type: "neoforge", version: "21.1.300" } });
    const check = await s.check();
    expect(check.latest.version).toBe("2");
    expect(check.installs[0]).toMatchObject({ version: "1", updateAvailable: true, needsReinstall: false });
    const u = await s.update();
    expect(u.results).toEqual([expect.objectContaining({ ok: true, version: "2", downloaded: 1, needsReinstall: false })]);
    expect(json(packFile).components).toEqual([
      { important: true, uid: "net.minecraft", version: "1.21.1" },
      { uid: "net.neoforged", version: "21.1.300" },
      { uid: "org.lwjgl3", version: "3.3.3" },
    ]);
    expect((await s.update()).results[0]).toMatchObject({ ok: true, upToDate: true });
  });

  test("a second instance never overwrites a folder; installs are found again with an empty store", async () => {
    publish(srv, packFiles(), "1");
    fs.mkdirSync(roaming("PrismLauncher", "instances", "Aniverse"), { recursive: true });
    const { s, clearStore } = service();
    const r = await s.install({ launcher: "prism" });
    expect(r.install.gameDir).toBe(roaming("PrismLauncher", "instances", "Aniverse 2", "minecraft"));
    clearStore();
    expect((await s.installs()).map((i) => i.installId)).toEqual([r.install.installId]);
    // Installing again in the same launcher updates the existing install.
    expect((await s.install({ launcher: "prism" })).results[0]).toMatchObject({ installId: r.install.installId, upToDate: true });
  });

  test("updates wait for the game to close, or report game-running", async () => {
    publish(srv, packFiles(), "1");
    let running = true;
    const { s } = service({ isGameRunning: async () => running });
    const { install } = await s.install({ launcher: "prism" });
    publish(srv, [...packFiles(), { path: "mods/b.jar", body: crypto.randomBytes(100) }], "2");
    expect((await s.update(install.installId)).results[0]).toMatchObject({ ok: false, code: "game-running" });
    setTimeout(() => (running = false), 50);
    expect((await s.update(install.installId, { waitForGameMs: 5000 })).results[0]).toMatchObject({ ok: true, version: "2" });
  });

  test("one job at a time; unknown installs and launchers are refused", async () => {
    publish(srv, [{ path: "mods/big.jar", body: crypto.randomBytes(400_000) }], "1");
    const { s } = service();
    const first = s.install({ launcher: "prism" });
    await new Promise((r) => setTimeout(r, 5));
    await expect(s.update()).rejects.toMatchObject({ code: "busy" });
    await first;
    await expect(s.update("nope")).rejects.toMatchObject({ code: "not-installed" });
    await expect(s.install({ launcher: "official" })).rejects.toMatchObject({ code: "launcher-not-found" });
    await expect(s.install({ launcher: "tlauncher" })).rejects.toMatchObject({ code: "launcher-not-found" });
  });
});

describe("official launcher", () => {
  const dataDir = () => roaming(".minecraft");
  const installer = Buffer.from("fake installer jar");

  beforeEach(() => {
    write(
      path.join(dataDir(), "launcher_profiles.json"),
      JSON.stringify({ profiles: { abc: { name: "", type: "latest-release", lastVersionId: "latest-release" } }, settings: { keepLauncherOpen: true }, version: 3 }),
    );
    const base = "/maven/releases/net/neoforged/neoforge/21.1.259/neoforge-21.1.259-installer.jar";
    srv.set(base, installer);
    srv.set(`${base}.sha1`, `${sha1(installer)}  neoforge-21.1.259-installer.jar\n`);
  });

  // The NeoForge installer: writes the version JSON and adds its own profile, like the real one.
  function fakeInstaller(calls) {
    return async (cmd, args) => {
      calls.push([cmd, ...args]);
      const dir = args[args.indexOf("--install-client") + 1];
      write(path.join(dir, "versions", "neoforge-21.1.259", "neoforge-21.1.259.json"), "{}");
      const file = path.join(dir, "launcher_profiles.json");
      const raw = json(file);
      raw.profiles.NeoForge = { name: "NeoForge", type: "custom", lastVersionId: "neoforge-21.1.259" };
      fs.writeFileSync(file, JSON.stringify(raw));
      return { code: 0, stdout: "", stderr: "" };
    };
  }

  test("installs NeoForge with Java, adds an Aniverse profile with its own game directory", async () => {
    publish(srv, packFiles(), "1");
    const calls = [];
    const { s } = service({ runImpl: fakeInstaller(calls), options: { iconDataUrl: "data:image/png;base64,AA==" } });
    const r = await s.install({ launcher: "official" });
    const gameDir = path.join(dataDir(), "modpacks", "aniverse");
    expect(r.install).toMatchObject({ launcher: "official", gameDir, version: "1" });
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe("/fake/java");
    expect(calls[0].slice(1, 2)).toEqual(["-jar"]);
    expect(calls[0].slice(3)).toEqual(["--install-client", dataDir()]);

    const raw = json(path.join(dataDir(), "launcher_profiles.json"));
    expect(Object.keys(raw.profiles).sort()).toEqual(["abc", "aniverse"]); // the installer's NeoForge profile is gone
    expect(raw.profiles.aniverse).toMatchObject({
      name: "Aniverse",
      type: "custom",
      lastVersionId: "neoforge-21.1.259",
      gameDir,
      icon: "data:image/png;base64,AA==",
    });
    expect(raw.profiles.aniverse.javaArgs).toStartWith("-Xmx6G ");
    expect(raw.settings).toEqual({ keepLauncherOpen: true });
    expect(fs.existsSync(path.join(gameDir, "mods", "a.jar"))).toBe(true);

    // The player's own memory setting survives a loader update; the version is installed only once.
    raw.profiles.aniverse.javaArgs = "-Xmx10G";
    fs.writeFileSync(path.join(dataDir(), "launcher_profiles.json"), JSON.stringify(raw));
    publish(srv, packFiles(), "2");
    await s.update();
    expect(calls).toHaveLength(1);
    expect(json(path.join(dataDir(), "launcher_profiles.json")).profiles.aniverse.javaArgs).toBe("-Xmx10G");
  });

  test("a NeoForge installer that does not match Maven's sha1 never runs", async () => {
    publish(srv, packFiles(), "1");
    srv.set("/maven/releases/net/neoforged/neoforge/21.1.259/neoforge-21.1.259-installer.jar", Buffer.from("tampered jar here!"));
    const calls = [];
    const { s } = service({ runImpl: fakeInstaller(calls) });
    await expect(s.install({ launcher: "official" })).rejects.toMatchObject({ code: "hash-mismatch" });
    expect(calls).toEqual([]);
    expect(json(path.join(dataDir(), "launcher_profiles.json")).profiles.aniverse).toBeUndefined();
  });

  test("a failing installer is loader-failed; Quilt is not supported here", async () => {
    publish(srv, packFiles(), "1");
    const { s } = service({ runImpl: async () => ({ code: 1, stdout: "", stderr: "Processor failed" }) });
    await expect(s.install({ launcher: "official" })).rejects.toMatchObject({ code: "loader-failed" });
    publish(srv, packFiles(), "1", { loader: { type: "quilt", version: "0.26.0" } });
    await expect(s.install({ launcher: "official" })).rejects.toMatchObject({ code: "loader-unsupported" });
  });
});

describe("Modrinth App", () => {
  beforeEach(() => fs.mkdirSync(roaming("ModrinthApp", "profiles"), { recursive: true }));

  // Modrinth App importing the .mrpack: a profile folder with the overrides extracted.
  function fakeModrinth(seen) {
    return async (file) => {
      const entries = readStoredZip(fs.readFileSync(file));
      seen.push(entries);
      const dir = roaming("ModrinthApp", "profiles", "Aniverse");
      for (const e of entries) {
        if (e.name.startsWith("overrides/")) write(path.join(dir, ...e.name.slice("overrides/".length).split("/")), e.data);
      }
      return "";
    };
  }

  test("imports a .mrpack through Modrinth App, then syncs the files into its profile", async () => {
    publish(srv, packFiles(), "1");
    const seen = [];
    const { s } = service({ openFile: fakeModrinth(seen) });
    const r = await s.install({ launcher: "modrinth" });
    const index = JSON.parse(seen[0].find((e) => e.name === "modrinth.index.json").data);
    expect(index).toEqual({
      formatVersion: 1,
      game: "minecraft",
      versionId: "1",
      name: "Aniverse",
      summary: "Aniverse modpack",
      files: [],
      dependencies: { minecraft: "1.21.1", neoforge: "21.1.259" },
    });
    const gameDir = roaming("ModrinthApp", "profiles", "Aniverse");
    expect(r.install).toMatchObject({ launcher: "modrinth", gameDir, version: "1" });
    expect(fs.existsSync(path.join(gameDir, "mods", "a.jar"))).toBe(true);
    expect(fs.readdirSync(path.join(tmp.dir, "tmp"))).toEqual([]); // the .mrpack is cleaned up

    // A loader change cannot be applied from outside: files still update, the install asks for a reinstall.
    publish(srv, packFiles(), "2", { loader: { type: "neoforge", version: "21.1.300" } });
    const u = await s.update();
    expect(u.results[0]).toMatchObject({ ok: true, version: "2", needsReinstall: true });
    expect((await s.installs())[0].needsReinstall).toBe(true);
  });

  test("no app for .mrpack, or no import in time", async () => {
    publish(srv, packFiles(), "1");
    await expect(service().s.install({ launcher: "modrinth" })).rejects.toMatchObject({ code: "launcher-not-found" });
    const { s } = service({ openFile: async () => "", options: { installTimeoutMs: 50 } });
    await expect(s.install({ launcher: "modrinth" })).rejects.toMatchObject({ code: "install-timeout" });
  });

  test("cancel stops the wait for the import", async () => {
    publish(srv, packFiles(), "1");
    const { s } = service({ openFile: async () => "" });
    const job = s.install({ launcher: "modrinth" });
    await new Promise((r) => setTimeout(r, 30));
    expect(s.status()).toMatchObject({ busy: true, job: { kind: "install", launcher: "modrinth" } });
    expect(s.cancel()).toBe(true);
    await expect(job).rejects.toMatchObject({ code: "cancelled" });
    expect(s.status().busy).toBe(false);
  });
});

describe("detection", () => {
  test("each launcher found, with the pack's install in it", async () => {
    write(roaming(".minecraft", "launcher_profiles.json"), JSON.stringify({ profiles: {} }));
    write(roaming("ModrinthApp", "app.db"), "");
    write(roaming("PrismLauncher", "prismlauncher.cfg"), "");
    fs.mkdirSync(roaming(".minecraft-without-profiles"), { recursive: true });
    const { s } = service();
    expect((await s.detect()).map((d) => [d.launcher, d.dataDir, d.installed])).toEqual([
      ["official", roaming(".minecraft"), null],
      ["modrinth", roaming("ModrinthApp"), null],
      ["prism", roaming("PrismLauncher"), null],
    ]);
  });
});

describe("launch", () => {
  const local = (...p) => path.join(tmp.dir, "Local", ...p);
  // The programs started, instead of really starting them
  const starter = (calls) => async (cmd, args) => {
    calls.push([cmd, ...args]);
  };

  test("Prism Launcher starts the instance itself; without its program: launcher-not-found", async () => {
    write(roaming("PrismLauncher", "prismlauncher.cfg"), "InstanceDir=instances\n");
    publish(srv, packFiles(), "1");
    const calls = [];
    const { s } = service({ startProgram: starter(calls) });
    const { install } = await s.install({ launcher: "prism" });
    await expect(s.launch(install.installId)).rejects.toMatchObject({ code: "launcher-not-found" });

    const exe = local("Programs", "PrismLauncher", "prismlauncher.exe");
    write(exe, "");
    expect(await s.launch(install.installId)).toEqual({ opened: "game", launcherName: "Prism Launcher" });
    expect(calls).toEqual([[exe, "--launch", "Aniverse"]]);
    await expect(s.launch("nope")).rejects.toMatchObject({ code: "not-installed" });
  });

  test("the official launcher opens on the pack's profile (the Store app through the shell)", async () => {
    const dataDir = roaming(".minecraft");
    write(path.join(dataDir, "launcher_profiles.json"), JSON.stringify({ profiles: { aniverse: { name: "Aniverse", lastUsed: "2020-01-01T00:00:00.000Z" } } }));
    fs.mkdirSync(local("Packages", "Microsoft.4297127D64EC6_8wekyb3d8bbwe"), { recursive: true });
    const calls = [];
    const record = { dataDir, gameDir: path.join(dataDir, "modpacks", "aniverse") };
    const windows = path.join(tmp.dir, "Windows");
    const sysWin = { ...sys, env: { ...sys.env, SystemRoot: windows, ProgramFiles: path.join(tmp.dir, "pf"), "ProgramFiles(x86)": path.join(tmp.dir, "pf86") } };
    expect(await official.launch(record, { sys: sysWin, start: starter(calls) })).toEqual({ opened: "launcher" });
    expect(calls).toEqual([[path.join(windows, "explorer.exe"), String.raw`shell:AppsFolder\Microsoft.4297127D64EC6_8wekyb3d8bbwe!Minecraft`]]);
    expect(Date.parse(json(path.join(dataDir, "launcher_profiles.json")).profiles.aniverse.lastUsed)).toBeGreaterThan(Date.now() - 60_000);
  });

  test("Modrinth App opens; a program that fails to start for another reason is reported", async () => {
    const dataDir = roaming("ModrinthApp");
    const exe = local("Modrinth App", "Modrinth App.exe");
    write(exe, "");
    const calls = [];
    expect(await modrinth.launch({ dataDir, gameDir: path.join(dataDir, "profiles", "Aniverse") }, { sys, start: starter(calls) })).toEqual({ opened: "launcher" });
    expect(calls).toEqual([[exe]]);
    const broken = async () => {
      throw Object.assign(new Error("denied"), { code: "EPERM" });
    };
    await expect(modrinth.launch({ dataDir, gameDir: dataDir }, { sys, start: broken })).rejects.toMatchObject({ code: "EPERM" });
  });
});
