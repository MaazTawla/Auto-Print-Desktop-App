"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

describe("pairing code Connect field", () => {
  it("is a visible text input (not password-masked)", () => {
    const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
    const m = html.match(/<input\b[^>]*\bid=["']settings-pairing-code["'][^>]*>/);
    assert.ok(m, "settings-pairing-code input missing");
    const tag = m[0];
    assert.match(tag, /\btype=["']text["']/);
    assert.doesNotMatch(tag, /\btype=["']password["']/);
    assert.doesNotMatch(tag, /\bautocomplete=["']new-password["']/);
  });
});
