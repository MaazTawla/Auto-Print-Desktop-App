"use strict";
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const L = require("../src/printer-field-limits");
const { createPrinterRegistry: R } = require("../src/printer-registry");

describe("R23D-M1 stale detail", () => {
  it("out_of_paper then ready / door then ready clear; null clears; absent keeps", () => {
    const r = R();
    r.upsert({ external_id: "lan:a:9100", name: "n", status: "out_of_paper" });
    r.upsert({ external_id: "lan:a:9100", name: "n", status: "online" });
    assert.equal(r.toSyncPayload()[0].status_detail, null);

    const r2 = R();
    r2.upsert({
      external_id: "lan:a:9100",
      name: "n",
      status: "error",
      status_detail: "Door open",
    });
    r2.upsert({ external_id: "lan:a:9100", name: "n", status: "online" });
    assert.equal(r2.toSyncPayload()[0].status_detail, null);

    const r3 = R();
    r3.upsert({
      external_id: "lan:a:9100",
      name: "n",
      status: "error",
      status_detail: "Door open",
    });
    r3.upsert({
      external_id: "lan:a:9100",
      name: "n",
      status: "error",
      status_detail: null,
    });
    assert.equal(r3.toSyncPayload()[0].status_detail, null);

    const r4 = R();
    r4.upsert({
      external_id: "lan:a:9100",
      name: "n",
      status: "error",
      status_detail: "Door open",
    });
    r4.upsert({ external_id: "lan:a:9100", name: "n", status: "error" });
    assert.equal(r4.toSyncPayload()[0].status_detail, "Door open");
  });
});

describe("R23D-L1 padded ports", () => {
  it("rejects 009100 / 0009100; keeps plain digit string and int", () => {
    assert.equal(L.sanitizePort("009100"), undefined);
    assert.equal(L.sanitizePort("0009100"), undefined);
    assert.equal(L.sanitizePort("9100"), 9100);
    assert.equal(L.sanitizePort(9100), 9100);
  });
});

describe("R23D-I1 D_overwrite", () => {
  it("out_of_paper with explicit detail keeps that detail", () => {
    const n = L.normalizeStatusFields("out_of_paper", "Tray empty", {
      detailProvided: true,
    });
    assert.equal(n.status_detail, "Tray empty");
  });
});
