"use strict";
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { createPrinterRegistry: R } = require("../src/printer-registry");

describe("R24D-L1 server sync omits undefined detail", () => {
  it("keeps local jam when server row has no status_detail", () => {
    const r = R();
    r.upsert({
      external_id: "lan:a:9100",
      name: "n",
      status: "error",
      status_detail: "jam",
    });
    r.applyServerSync([
      { external_id: "lan:a:9100", id: 7, name: "n", status: "error" },
    ]);
    assert.equal(r.get("lan:a:9100").status_detail, "jam");
  });
});

describe("R24D-L2 status-less upsert", () => {
  it("{server_id} only keeps offline unplugged; offline→online clears; null clears", () => {
    const r = R();
    r.upsert({
      external_id: "lan:a:9100",
      name: "n",
      status: "offline",
      status_detail: "unplugged",
    });
    r.upsert({ external_id: "lan:a:9100", name: "n", server_id: 5 });
    assert.equal(r.get("lan:a:9100").status_detail, "unplugged");
    r.upsert({ external_id: "lan:a:9100", name: "n", status: "online" });
    assert.equal(r.get("lan:a:9100").status_detail, null);

    const r2 = R();
    r2.upsert({
      external_id: "lan:a:9100",
      name: "n",
      status: "error",
      status_detail: "jam",
    });
    r2.upsert({ external_id: "lan:a:9100", name: "n", status_detail: null });
    assert.equal(r2.get("lan:a:9100").status_detail, null);
  });
});
