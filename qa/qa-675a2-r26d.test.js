"use strict";
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { createPrinterRegistry: R } = require("../src/printer-registry");
const L = require("../src/printer-field-limits");

describe("R26D-L1 blank status", () => {
  it("offline unplugged + {status:''} / {status:'  '} stays offline unplugged", () => {
    const r = R();
    r.upsert({
      external_id: "lan:a:9100",
      name: "n",
      status: "offline",
      status_detail: "unplugged",
    });
    r.upsert({ external_id: "lan:a:9100", name: "n", status: "" });
    assert.equal(r.get("lan:a:9100").status, "offline");
    assert.equal(r.get("lan:a:9100").status_detail, "unplugged");
    r.upsert({ external_id: "lan:a:9100", name: "n", status: "  " });
    assert.equal(r.get("lan:a:9100").status, "offline");
    assert.equal(r.get("lan:a:9100").status_detail, "unplugged");
    assert.equal(L.isStatusValueProvided(""), false);
  });
});
