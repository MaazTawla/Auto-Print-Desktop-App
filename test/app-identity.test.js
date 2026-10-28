"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  getOrCreateAppId,
  createFileAppIdStore,
  isUuidLike,
} = require("../src/app-identity");

describe("app-identity", () => {
  it("creates and reuses app_id on disk", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tawla-appid-"));
    const cfgPath = path.join(dir, "config.json");
    const store = createFileAppIdStore(cfgPath);
    const a = getOrCreateAppId(store);
    const b = getOrCreateAppId(store);
    assert.equal(a, b);
    assert.equal(isUuidLike(a), true);
    const written = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    assert.equal(written.app_id, a);
  });
});
