// ─── Fetch the ffmpeg binaries electron-builder ships ────────────────────────
// ffmpeg-static only downloads the binary of the machine it is installed on,
// so a Windows ia32 or a macOS arm64 build would ship the wrong one. This
// downloads the same release ffmpeg-static uses for every packaged target
// into vendor/ffmpeg/<os>-<arch>/ (os as electron-builder's ${os} macro:
// win | mac | linux), copied to resources/ffmpeg by build.extraResources.
//
//   node scripts/fetch-ffmpeg.js                  targets of this platform
//   node scripts/fetch-ffmpeg.js win              win-x64 + win-ia32
//   node scripts/fetch-ffmpeg.js win-x64 mac-arm64
//   node scripts/fetch-ffmpeg.js all [--force]

const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");
const { execFileSync } = require("child_process");

// Targets of package.json → build.win / build.mac / build.linux.
const TARGETS = {
  win: ["x64", "ia32"],
  mac: ["x64", "arm64"],
  linux: ["x64"],
};
const NODE_PLATFORM = { win: "win32", mac: "darwin", linux: "linux" };
const HOST_OS = { win32: "win", darwin: "mac", linux: "linux" }[process.platform];

// ffmpeg-static's release has no win32-ia32 binary since b6.1.1: a target
// missing from it comes from the newest older release that has one.
const FALLBACK_TAGS = ["b6.0"];

const ROOT = path.join(__dirname, "..");
const VENDOR = path.join(ROOT, "vendor", "ffmpeg");

function releaseInfo() {
  const pkg = require("ffmpeg-static/package.json");
  const conf = pkg["ffmpeg-static"];
  const tag = process.env[conf["binary-release-tag-env-var"]] || conf["binary-release-tag"];
  const base =
    process.env[conf["binaries-url-env-var"]] ||
    "https://github.com/eugeneware/ffmpeg-static/releases/download";
  return { tag, base };
}

function parseTargets(args) {
  const names = args.filter((a) => !a.startsWith("--"));
  if (!names.length) names.push(HOST_OS);
  const targets = [];
  for (const name of names) {
    if (name === "all") {
      for (const [o, arches] of Object.entries(TARGETS)) {
        arches.forEach((arch) => targets.push({ os: o, arch }));
      }
    } else if (TARGETS[name]) {
      TARGETS[name].forEach((arch) => targets.push({ os: name, arch }));
    } else {
      const [o, arch] = name.split("-");
      if (!TARGETS[o]?.includes(arch)) throw new Error(`Unknown target "${name}"`);
      targets.push({ os: o, arch });
    }
  }
  return targets;
}

async function download(url, destination, { gunzip = false, optional = false } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { redirect: "follow" });
      if (res.status === 404 && optional) {
        console.warn(`  (not found: ${url})`);
        return false;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      const tmp = `${destination}.download`;
      const streams = [Readable.fromWeb(res.body)];
      if (gunzip) streams.push(zlib.createGunzip());
      streams.push(fs.createWriteStream(tmp));
      await pipeline(...streams);
      fs.renameSync(tmp, destination);
      return true;
    } catch (err) {
      if (attempt >= 3) throw err;
      console.warn(`  retry ${attempt}: ${err.message}`);
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}

// Where the binary's source is (GPL: it ships with directions to it): the
// release's build notes for this target, and the FFmpeg source itself.
async function writeSourceNotice(dir, { base, used, platform, arch }) {
  await download(`${base}/${used}/${platform}-${arch}.README`, path.join(dir, "README"), {
    optional: true,
  });
  const version = used.replace(/^b/, "");
  fs.writeFileSync(
    path.join(dir, "SOURCE.txt"),
    [
      `This ffmpeg binary is FFmpeg ${version}, licensed under the GNU GPL (see LICENSE).`,
      `It comes from the ffmpeg-static release ${used}: ${base}/${used}`,
      "(README, when present, names the build and its configuration).",
      `FFmpeg ${version} source code: https://ffmpeg.org/releases/ffmpeg-${version}.tar.xz`,
      "",
    ].join("\n"),
  );
}

async function fetchTarget({ os: targetOs, arch }, { tag, base }, force) {
  const platform = NODE_PLATFORM[targetOs];
  const dir = path.join(VENDOR, `${targetOs}-${arch}`);
  const exe = path.join(dir, targetOs === "win" ? "ffmpeg.exe" : "ffmpeg");
  const stamp = path.join(dir, "RELEASE");
  const current = fs.existsSync(stamp) ? fs.readFileSync(stamp, "utf8").trim() : null;
  const tags = [tag, ...FALLBACK_TAGS.filter((t) => t !== tag)];

  if (!force && tags.includes(current) && fs.existsSync(exe) && fs.statSync(exe).size > 0) {
    console.log(`ffmpeg ${current} ${targetOs}-${arch}: already there`);
    if (!fs.existsSync(path.join(dir, "SOURCE.txt"))) {
      await writeSourceNotice(dir, { base, used: current, platform, arch });
    }
    return exe;
  }
  fs.mkdirSync(dir, { recursive: true });
  let used = null;
  for (const candidate of tags) {
    console.log(`ffmpeg ${candidate} ${targetOs}-${arch}: downloading…`);
    const url = `${base}/${candidate}/ffmpeg-${platform}-${arch}.gz`;
    if (await download(url, exe, { gunzip: true, optional: true })) {
      used = candidate;
      break;
    }
  }
  if (!used) throw new Error(`no ffmpeg binary for ${targetOs}-${arch} (${tags.join(", ")})`);
  fs.chmodSync(exe, 0o755);
  // GPL build: ship its licence next to it (the package's GPL text when the
  // release has none for this target).
  const license = path.join(dir, "LICENSE");
  const found = await download(`${base}/${used}/${platform}-${arch}.LICENSE`, license, {
    optional: true,
  });
  if (!found) fs.copyFileSync(require.resolve("ffmpeg-static/LICENSE"), license);
  await writeSourceNotice(dir, { base, used, platform, arch });
  fs.writeFileSync(stamp, `${used}\n`);
  console.log(`  → ${path.relative(ROOT, exe)} (${(fs.statSync(exe).size / 1e6).toFixed(1)} MB)`);
  return exe;
}

function canRunHere({ os: targetOs, arch }) {
  if (targetOs !== HOST_OS) return false;
  if (arch === os.arch()) return true;
  return targetOs === "win" && arch === "ia32" && os.arch() === "x64";
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const info = releaseInfo();
  for (const target of parseTargets(args)) {
    const exe = await fetchTarget(target, info, force);
    if (canRunHere(target)) {
      const version = execFileSync(exe, ["-hide_banner", "-version"], { encoding: "utf8" });
      console.log(`  ${version.split(/\r?\n/)[0]}`);
    }
  }
}

main().catch((err) => {
  console.error(`[fetch-ffmpeg] ${err.message}`);
  process.exit(1);
});
