"use strict";
const test = require("node:test");
const assert = require("node:assert");
const dn = require("../src/device-name");

test("hostname trimmed", () => {
  assert.equal(dn.defaultDeviceName({ hostname: () => "  FRONT-DESK-PC \n", env: {} }), "FRONT-DESK-PC");
});
test("blank hostname falls back to COMPUTERNAME then generic", () => {
  assert.equal(dn.defaultDeviceName({ hostname: () => " \u200B ", env: { COMPUTERNAME: "KITCHEN-PC" } }), "KITCHEN-PC");
  assert.equal(dn.defaultDeviceName({ hostname: () => { throw new Error("x"); }, env: {} }), dn.FALLBACK);
});
test("strips control/invisible chars and caps at 120", () => {
  assert.equal(dn.sanitizeDeviceName("\uFEFFBar\u0007  \t PC\u200D"), "Bar PC");
  const s = dn.sanitizeDeviceName("a".repeat(119) + "\u{1F600}bbb");
  assert.equal(Array.from(s).length, 120);
  assert.ok(s.endsWith("\u{1F600}"));
  assert.equal(dn.sanitizeDeviceName("   "), null);
});
test("stored label wins; blank stored uses default", () => {
  const o = { hostname: () => "HOST", env: {} };
  assert.equal(dn.labelOrDefault(" My till ", o), "My till");
  assert.equal(dn.labelOrDefault("  ", o), "HOST");
  assert.equal(dn.labelOrDefault(undefined, o), "HOST");
});
