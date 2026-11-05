"use strict";
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const L = require("../src/printer-field-limits");
const { createPrinterRegistry: R } = require("../src/printer-registry");

describe("L14-I4 empty port omitted", () => {
  it("'' / whitespace omit; keep stored; never send 0", () => {
    assert.equal(L.sanitizePort(""), undefined);
    assert.equal(L.sanitizePort("  "), undefined);
    assert.equal(L.sanitizePort(0), undefined);
    const r = R();
    r.upsert({ external_id: "lan:a:9100", name: "n", port: 9100 });
    r.upsert({ external_id: "lan:a:9100", name: "n", port: "" });
    assert.equal(r.get("lan:a:9100").port, 9100);
    assert.equal(r.toSyncPayload()[0].port, 9100);
  });
});

describe("L14-I5 invisible-only blank", () => {
  it("ZWJ-only falls back; mixed invisible falls back; family emoji intact", () => {
    assert.equal(L.resolvePrinterName("\u200d", "lan:a:9100"), "lan:a:9100");
    assert.equal(
      L.resolvePrinterName("\u00a0\u200b\u200c\u200d\u2060\ufeff ", "lan:b:9100"),
      "lan:b:9100"
    );
    assert.equal(L.resolvePrinterName("👨‍👩‍👧", "id"), "👨‍👩‍👧");
  });
});
