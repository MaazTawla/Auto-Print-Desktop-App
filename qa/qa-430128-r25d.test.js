"use strict";
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { createPrinterRegistry: R } = require("../src/printer-registry");
const L = require("../src/printer-field-limits");

describe("R25D-L1 bare server sync", () => {
  it("offline unplugged + applyServerSync([{id, external_id}]) stays offline/unplugged", () => {
    const r = R();
    r.upsert({
      external_id: "lan:a:9100",
      name: "n",
      status: "offline",
      status_detail: "unplugged",
    });
    r.applyServerSync([{ id: 11, external_id: "lan:a:9100" }]);
    assert.equal(r.get("lan:a:9100").status, "offline");
    assert.equal(r.get("lan:a:9100").status_detail, "unplugged");
  });
});

describe("R25D-L2 null/undefined status", () => {
  it("keeps stored offline/unplugged; never error", () => {
    const r = R();
    r.upsert({
      external_id: "lan:a:9100",
      name: "n",
      status: "offline",
      status_detail: "unplugged",
    });
    r.upsert({ external_id: "lan:a:9100", name: "n", status: undefined });
    r.upsert({ external_id: "lan:a:9100", name: "n", status: null });
    assert.equal(r.get("lan:a:9100").status, "offline");
    assert.equal(r.get("lan:a:9100").status_detail, "unplugged");
    assert.equal(
      L.normalizeStatusFields(null, null, { statusProvided: true }).status,
      null
    );
  });
});
