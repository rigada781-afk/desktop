const { describe, test, expect } = require("bun:test");
const fs = require("fs");
const path = require("path");
const config = require("../config");

const ROOT = path.join(__dirname, "..");

describe("packaged builds", () => {
  test("the AppUserModelID is the installer's appId", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    expect(config.APP_USER_MODEL_ID).toBe(pkg.build.appId);
  });

  test("the main process never reads package.json's build config: electron-builder strips it", () => {
    for (const file of ["main.js", "settings.js", "updater.js", "rpc.js", "server.js", "config.js"]) {
      const code = fs.readFileSync(path.join(ROOT, file), "utf8");
      expect(code).not.toMatch(/package\.json["']\)\s*\.build\b/);
      expect(code).not.toMatch(/\.build\.appId/);
    }
  });
});
