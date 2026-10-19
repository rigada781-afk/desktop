// ─── The .avm file icon ──────────────────────────────────────────────────────
// Draws the icon the system shows for .avm files (a manga chapter downloaded
// on Aniverse, opened by this app: package.json build.fileAssociations) and
// writes assets/icons/avm/avm.{png,ico,icns}: a page in the app icon's dark
// purple, the logo, an "AVM" label (left out at 16–32 px, where it can't be
// read). Run again after changing the drawing:
//
//   node scripts/avm-icon.js
//
// Needs sharp, which the site has (../site/node_modules) or set SHARP_PATH.

const fs = require("fs");
const path = require("path");

const sharp = require(process.env.SHARP_PATH || path.join(__dirname, "..", "..", "site", "node_modules", "sharp"));

const ROOT = path.join(__dirname, "..");
const LOGO = path.join(ROOT, "assets", "icons", "transparant", "512.png");
const OUT = path.join(ROOT, "assets", "icons", "avm");

function svg({ label }) {
  const logo = fs.readFileSync(LOGO).toString("base64");
  // The page: 720 × 960 in a 1024 square, its top right corner folded
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="page" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#0d0a10"/>
      <stop offset="1" stop-color="#22002e"/>
    </linearGradient>
    <linearGradient id="fold" x1="0" y1="1" x2="1" y2="0">
      <stop offset="0" stop-color="#5a1f73"/>
      <stop offset="1" stop-color="#8a3aa8"/>
    </linearGradient>
    <linearGradient id="band" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#b026ff"/>
      <stop offset="0.6" stop-color="#df82cf"/>
      <stop offset="1" stop-color="#f4c4d6"/>
    </linearGradient>
  </defs>
  <path d="M 224 32 H 672 L 872 232 V 920 Q 872 992 800 992 H 224 Q 152 992 152 920 V 104 Q 152 32 224 32 Z"
        fill="url(#page)" stroke="#4b1a60" stroke-width="10"/>
  <path d="M 672 32 V 172 Q 672 232 732 232 H 872 Z" fill="url(#fold)"/>
  ${
    label
      ? `<image href="data:image/png;base64,${logo}" x="192" y="200" width="640" height="640"/>
  <rect x="242" y="752" width="540" height="150" rx="75" fill="url(#band)"/>
  <text x="512" y="858" text-anchor="middle" font-family="Segoe UI, Helvetica Neue, Arial, sans-serif"
        font-weight="800" font-size="112" letter-spacing="10" fill="#1b0424">AVM</text>`
      : `<image href="data:image/png;base64,${logo}" x="178" y="262" width="668" height="668"/>`
  }
</svg>`;
}

async function png(size) {
  // Small sizes: the logo alone, larger
  return sharp(Buffer.from(svg({ label: size >= 48 })), { density: Math.max(72, (72 * size) / 1024 * 4) })
    .resize(size, size)
    .png()
    .toBuffer();
}

/** An .ico of PNG images (Windows Vista and later read them). */
function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + 16 * images.length;
  for (const { size, data } of images) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(entry);
  }
  return Buffer.concat([header, ...entries, ...images.map((image) => image.data)]);
}

/** An .icns of PNG images, by their type codes. */
function icns(images) {
  const chunks = images.map(({ type, data }) => {
    const head = Buffer.alloc(8);
    head.write(type, 0, "ascii");
    head.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([head, data]);
  });
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(8);
  head.write("icns", 0, "ascii");
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
  const rendered = Object.fromEntries(await Promise.all(sizes.map(async (size) => [size, await png(size)])));

  fs.writeFileSync(path.join(OUT, "avm.png"), rendered[512]);
  fs.writeFileSync(
    path.join(OUT, "avm.ico"),
    ico([16, 24, 32, 48, 64, 128, 256].map((size) => ({ size, data: rendered[size] }))),
  );
  fs.writeFileSync(
    path.join(OUT, "avm.icns"),
    icns([
      { type: "icp4", data: rendered[16] },
      { type: "icp5", data: rendered[32] },
      { type: "icp6", data: rendered[64] },
      { type: "ic07", data: rendered[128] },
      { type: "ic08", data: rendered[256] },
      { type: "ic09", data: rendered[512] },
      { type: "ic10", data: rendered[1024] },
    ]),
  );
  for (const name of ["avm.png", "avm.ico", "avm.icns"]) {
    console.log(name, fs.statSync(path.join(OUT, name)).size, "bytes");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
