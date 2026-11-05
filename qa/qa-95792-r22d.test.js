"use strict";
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const L = require("../src/printer-field-limits");
const { createPrinterRegistry: R } = require("../src/printer-registry");

describe("R22D-L1 status detail", () => {
  it("out_of_paper → error with Out of paper; existing detail kept", () => {
    const r = R();
    r.upsert({ external_id: "lan:a:9100", name: "n", status: "out_of_paper" });
    const p = r.toSyncPayload()[0];
    assert.equal(p.status, "error");
    assert.equal(p.status_detail, "Out of paper");
    r.upsert({
      external_id: "lan:a:9100",
      name: "n",
      status: "paused",
      status_detail: "Door open",
    });
    const p2 = r.toSyncPayload()[0];
    assert.equal(p2.status, "error");
    assert.equal(p2.status_detail, "Door open");
  });
});

describe("R22D-L2 name cleaning", () => {
  it("keeps ZWJ and inner spaces; blank-makers fall back", () => {
    assert.equal(L.resolvePrinterName("👨‍👩‍👧", "id"), "👨‍👩‍👧");
    assert.equal(L.resolvePrinterName("A  B", "id"), "A  B");
    assert.equal(L.resolvePrinterName("\u00a0\u200b\u2060\ufeff ", "lan:x:9100"), "lan:x:9100");
    assert.equal(L.resolvePrinterName("Kit\u200bchen", "id"), "Kit\u200bchen");
  });
});

describe("R22D-L3 / I1 ports", () => {
  it("strict port: boundaries, digit string, keep prior on invalid", () => {
    assert.equal(L.sanitizePort(65535), 65535);
    assert.equal(L.sanitizePort(65536), undefined);
    assert.equal(L.sanitizePort("9100"), 9100);
    assert.equal(L.sanitizePort(true), undefined);
    assert.equal(L.sanitizePort("0x10"), undefined);
    assert.equal(L.sanitizePort(9100.5), undefined);
    const r = R();
    r.upsert({ external_id: "lan:a:9100", name: "n", port: 9100 });
    r.upsert({ external_id: "lan:a:9100", name: "n", port: 0 });
    assert.equal(r.get("lan:a:9100").port, 9100);
  });
});
