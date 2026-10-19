const { describe, test, expect } = require("bun:test");
const crypto = require("crypto");
const {
  sequenceIv,
  segmentIv,
  decryptAes128,
  findTsStart,
  isPackedAudio,
} = require("../downloads/aes");
const { parseIv } = require("../downloads/hls");
const { DownloadError } = require("../downloads/errors");

function encrypt(plain, key, iv) {
  const cipher = crypto.createCipheriv("aes-128-cbc", key, iv);
  return Buffer.concat([cipher.update(plain), cipher.final()]);
}

function fakeTs(packets) {
  const buf = Buffer.alloc(188 * packets, 0xff);
  for (let i = 0; i < packets; i++) buf[i * 188] = 0x47;
  return buf;
}

describe("IV derivation", () => {
  test("media sequence number as a 16-byte big-endian integer", () => {
    expect(sequenceIv(0).toString("hex")).toBe("0".repeat(32));
    expect(sequenceIv(1).toString("hex")).toBe(`${"0".repeat(31)}1`);
    expect(sequenceIv(258).toString("hex")).toBe(`${"0".repeat(28)}0102`);
    expect(sequenceIv(2 ** 40).toString("hex")).toBe(`${"0".repeat(21)}10000000000`);
  });

  test("explicit IV wins, short hex is left-padded", () => {
    expect(parseIv("0x1").toString("hex")).toBe(`${"0".repeat(31)}1`);
    expect(parseIv("0X0123456789ABCDEF0123456789ABCDEF").toString("hex")).toBe(
      "0123456789abcdef0123456789abcdef",
    );
    const iv = parseIv("0xff");
    expect(segmentIv({ iv }, 99)).toBe(iv);
    expect(segmentIv({ iv: null }, 5).equals(sequenceIv(5))).toBe(true);
    expect(() => parseIv("0xZZ")).toThrow(DownloadError);
  });
});

describe("AES-128-CBC", () => {
  const key = crypto.randomBytes(16);
  const plain = fakeTs(20);

  test("round trip with an explicit IV", () => {
    const iv = crypto.randomBytes(16);
    const out = decryptAes128(encrypt(plain, key, iv), key, iv);
    expect(out.equals(plain)).toBe(true);
    expect(out[0]).toBe(0x47);
  });

  test("round trip with the sequence-number IV", () => {
    const iv = segmentIv({ iv: null }, 1234);
    expect(decryptAes128(encrypt(plain, key, iv), key, iv).equals(plain)).toBe(true);
  });

  test("a wrong key or a cut body is a retryable error, a bad key length is not", () => {
    const iv = sequenceIv(1);
    const cipher = encrypt(plain, key, iv);
    let caught;
    try {
      decryptAes128(cipher.subarray(0, cipher.length - 5), key, iv);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DownloadError);
    expect(caught.retryable).toBe(true);
    expect(() => decryptAes128(cipher, Buffer.alloc(8), iv)).toThrow("16 bytes");
  });
});

describe("segment checks", () => {
  test("TS sync byte at 0", () => {
    expect(findTsStart(fakeTs(3))).toBe(0);
  });
  test("disguised segment: a fake image header before the TS packets", () => {
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
    expect(findTsStart(Buffer.concat([png, fakeTs(4)]))).toBe(png.length);
  });
  test("HTML or random data is not TS", () => {
    expect(findTsStart(Buffer.from("<html><body>403</body></html>"))).toBe(-1);
    expect(findTsStart(Buffer.alloc(0))).toBe(-1);
  });
  test("packed audio: ID3 or ADTS", () => {
    expect(isPackedAudio(Buffer.from("ID3\u0004\u0000"))).toBe(true);
    expect(isPackedAudio(Buffer.from([0xff, 0xf1, 0x50, 0x80]))).toBe(true);
    expect(isPackedAudio(fakeTs(1))).toBe(false);
  });
});
