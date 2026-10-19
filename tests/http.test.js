const { describe, test, expect } = require("bun:test");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createHttp, parseRetryAfter, looksLikeHtml } = require("../downloads/http");
const { DownloadError, abortError } = require("../downloads/errors");

// fetch stub: answers from a list of (url, init) => Response | Error.
function scripted(...answers) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, headers: { ...init.headers } });
    const next = answers.length > 1 ? answers.shift() : answers[0];
    const value = typeof next === "function" ? await next(url, init) : next;
    if (value instanceof Error) throw value;
    return value.clone();
  };
  return { fetch, calls };
}

function noSleep() {
  const waits = [];
  return { waits, sleep: async (ms) => void waits.push(ms) };
}

const ts = () => new Response(Buffer.from([0x47, 1, 2, 3]), { status: 200 });

describe("getBuffer", () => {
  test("sends the headers, returns the body", async () => {
    const { fetch, calls } = scripted(ts());
    const http = createHttp({ fetch });
    const buf = await http.getBuffer("https://cdn/a.ts", { headers: { Referer: "https://r/" } });
    expect([...buf]).toEqual([0x47, 1, 2, 3]);
    expect(calls[0].headers).toEqual({ Referer: "https://r/" });
  });

  test("5xx and network errors are retried with backoff", async () => {
    const { fetch, calls } = scripted(
      new Response("x", { status: 503 }),
      new TypeError("fetch failed"),
      ts(),
    );
    const { waits, sleep } = noSleep();
    const http = createHttp({ fetch, sleep });
    await http.getBuffer("https://cdn/a.ts");
    expect(calls).toHaveLength(3);
    expect(waits).toEqual([500, 1000]);
  });

  test("Retry-After is honoured", async () => {
    const { fetch } = scripted(new Response("", { status: 429, headers: { "retry-after": "3" } }), ts());
    const { waits, sleep } = noSleep();
    await createHttp({ fetch, sleep }).getBuffer("https://cdn/a.ts");
    expect(waits).toEqual([3000]);
    expect(parseRetryAfter("120")).toBe(30_000);
    expect(parseRetryAfter(new Date(Date.now() + 2000).toUTCString())).toBeGreaterThan(0);
  });

  test("403 is retried 5 times, then 'forbidden'", async () => {
    const { fetch, calls } = scripted(new Response("<html>nginx</html>", { status: 403 }));
    const { waits, sleep } = noSleep();
    const err = await createHttp({ fetch, sleep })
      .getBuffer("https://cdn.host/a.ts?token=secret")
      .catch((e) => e);
    expect(err).toBeInstanceOf(DownloadError);
    expect(err.code).toBe("forbidden");
    expect(err.message).toBe("HTTP 403 (cdn.host)");
    expect(err.message).not.toContain("secret");
    expect(calls).toHaveLength(5);
    expect(waits).toEqual([500, 1000, 2000, 4000]);
  });

  test("a 403 is tried again at once without Origin, then without Referer (zoko's segment CDN)", async () => {
    // Cloudflare keeps a cached 403 for requests with an Origin; plainer ones get the segment
    const { fetch, calls } = scripted((url, init) =>
      "Origin" in init.headers ? new Response("<html>403</html>", { status: 403 }) : ts(),
    );
    const { waits, sleep } = noSleep();
    const headers = { Origin: "https://zoko.test", Referer: "https://zoko.test/", Authorization: "Bearer jwt", "User-Agent": "UA" };
    const body = await createHttp({ fetch, sleep }).getBuffer("https://seg.host/s10.ts", { headers });
    expect(body[0]).toBe(0x47);
    expect(calls.map((c) => Object.keys(c.headers).sort())).toEqual([
      ["Authorization", "Origin", "Referer", "User-Agent"],
      ["Authorization", "Referer", "User-Agent"],
    ]);
    expect(waits).toEqual([]);
    // Sizes fall back the same way
    const sized = scripted((url, init) =>
      "Origin" in init.headers || "Referer" in init.headers
        ? new Response("", { status: 403 })
        : new Response("x", { status: 206, headers: { "content-range": "bytes 0-0/1234" } }),
    );
    expect(await createHttp({ fetch: sized.fetch, sleep }).getSize("https://seg.host/s11.ts", { headers })).toBe(1234);
    expect(sized.calls.map((c) => Object.keys(c.headers).sort())).toEqual([
      ["Authorization", "Origin", "Range", "Referer", "User-Agent"],
      ["Authorization", "Range", "Referer", "User-Agent"],
      ["Authorization", "Range", "User-Agent"],
    ]);
  });

  test("a host that refuses every header set: each attempt tries them all, Authorization always kept", async () => {
    const { fetch, calls } = scripted(new Response("<html>403</html>", { status: 403 }));
    const { waits, sleep } = noSleep();
    const err = await createHttp({ fetch, sleep })
      .getBuffer("https://seg.host/a.ts", { headers: { Origin: "o", Referer: "r", Authorization: "Bearer jwt" } })
      .catch((e) => e);
    expect(err.code).toBe("forbidden");
    expect(calls).toHaveLength(15); // 5 attempts × 3 header sets
    expect(waits).toEqual([500, 1000, 2000, 4000]);
    expect(calls.every((c) => c.headers.Authorization === "Bearer jwt")).toBe(true);
    // each attempt starts again with every header
    expect(calls.filter((c) => "Origin" in c.headers)).toHaveLength(5);
  });

  test("404 is not retried and means 'expired'", async () => {
    const { fetch, calls } = scripted(new Response("", { status: 404 }));
    const err = await createHttp({ fetch, ...noSleep() }).getBuffer("https://cdn/a.ts").catch((e) => e);
    expect(err.code).toBe("expired");
    expect(calls).toHaveLength(1);
  });

  test("an HTML body where media is expected is refused", async () => {
    const { fetch, calls } = scripted(
      new Response("  <!DOCTYPE html><title>Just a moment</title>", { status: 200 }),
    );
    const err = await createHttp({ fetch, ...noSleep() }).getBuffer("https://cdn/a.ts").catch((e) => e);
    expect(err.code).toBe("forbidden");
    expect(calls).toHaveLength(5);
    expect(looksLikeHtml(Buffer.from("\n<html>"))).toBe(true);
    expect(looksLikeHtml(Buffer.from([0x47, 0x3c]))).toBe(false);
  });

  test("checkHtml 'header' lets an encrypted body start with '<'", async () => {
    const { fetch } = scripted(new Response(Buffer.from("<\u0001\u0002"), { status: 200 }));
    const buf = await createHttp({ fetch }).getBuffer("https://cdn/a.ts", { checkHtml: "header" });
    expect(buf.length).toBe(3);
  });

  test("a retryable transform error is retried", async () => {
    const { fetch, calls } = scripted(ts());
    let n = 0;
    const buf = await createHttp({ fetch, ...noSleep() }).getBuffer("https://cdn/a.ts", {
      transform: (body) => {
        if (++n < 3) throw new DownloadError("unsupported", "bad", { retryable: true });
        return body;
      },
    });
    expect(buf[0]).toBe(0x47);
    expect(calls).toHaveLength(3);
  });

  test("a stalled answer times out and is retried", async () => {
    let attempt = 0;
    const fetch = (url, init) =>
      new Promise((resolve, reject) => {
        if (++attempt === 2) return resolve(ts());
        init.signal.addEventListener("abort", () => reject(init.signal.reason));
      });
    const buf = await createHttp({ fetch, timeoutMs: 30, ...noSleep() }).getBuffer("https://cdn/a.ts");
    expect(buf[0]).toBe(0x47);
    expect(attempt).toBe(2);
  });

  test("aborting the job signal stops at once with its reason", async () => {
    const controller = new AbortController();
    const fetch = (url, init) =>
      new Promise((_, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const pending = createHttp({ fetch }).getBuffer("https://cdn/a.ts", { signal: controller.signal });
    controller.abort(abortError("pause"));
    const err = await pending.catch((e) => e);
    expect(err.kind).toBe("pause");
  });
});

describe("downloadToFile", () => {
  test("a disk error (folder not writable, disk full) is not retried and reads as the disk", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aniverse-http-"));
    try {
      // The target is a folder: opening it for writing fails as the disk would
      const target = path.join(dir, "film.part.mp4");
      fs.mkdirSync(target);
      const { fetch, calls } = scripted(new Response(Buffer.alloc(100, 1), { status: 200 }));
      const err = await createHttp({ fetch, ...noSleep() }).downloadToFile("https://cdn/f.mp4", target).catch((e) => e);
      expect(err instanceof DownloadError).toBe(false);
      expect(typeof err.syscall).toBe("string");
      expect(require("../downloads/errors").toRecordError(err).code).toBe("disk");
      expect(calls).toHaveLength(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("resumes with Range after a dropped connection", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aniverse-http-"));
    const file = path.join(dir, "film.part.mp4");
    const full = Buffer.alloc(1000, 7);
    full.write("\u0000\u0000\u0000\u0018ftyp", 0, "latin1");
    let attempt = 0;
    const ranges = [];
    const fetch = async (url, init) => {
      ranges.push(init.headers.Range || null);
      attempt++;
      if (attempt === 1) {
        // 400 bytes, then the connection drops.
        let sent = false;
        const body = new ReadableStream({
          pull(c) {
            if (sent) return c.error(new TypeError("terminated"));
            sent = true;
            c.enqueue(full.subarray(0, 400));
          },
        });
        return new Response(body, { status: 200, headers: { "content-length": "1000" } });
      }
      const start = Number(/bytes=(\d+)-/.exec(init.headers.Range)[1]);
      return new Response(full.subarray(start), {
        status: 206,
        headers: { "content-range": `bytes ${start}-999/1000` },
      });
    };
    const totals = [];
    try {
      const result = await createHttp({ fetch, ...noSleep() }).downloadToFile("https://cdn/f.mp4", file, {
        onTotal: (t) => totals.push(t),
      });
      expect(result).toEqual({ size: 1000, total: 1000 });
      expect(ranges).toEqual([null, "bytes=400-"]);
      expect(fs.readFileSync(file).equals(full)).toBe(true);
      expect(totals).toEqual([1000, 1000]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
