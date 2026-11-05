"use strict";
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

describe("R8D-I2/I3 npm test scoping", () => {
  it("npm test is scoped to test/*.js and test:qa uses qa/*.test.js glob", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
    assert.equal(pkg.scripts.test, "node --test test/*.js");
    assert.equal(pkg.scripts["test:qa"], "node --test qa/*.test.js");
    // Directory arg `qa/` is broken on Node 24; glob is required.
    assert.ok(!/^node --test qa\/?$/.test(pkg.scripts["test:qa"]));
  });
});
