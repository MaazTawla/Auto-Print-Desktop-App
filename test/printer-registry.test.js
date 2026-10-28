"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { createPrinterRegistry } = require("../src/printer-registry");

describe("printer-registry", () => {
  it("syncs Windows list with no cap and stable external_id", () => {
    const reg = createPrinterRegistry();
    const many = [];
    for (let i = 0; i < 20; i++) {
      many.push({ name: `Printer ${i}`, portName: `USB00${i}` });
    }
    const list = reg.syncFromWindowsList(many);
    assert.equal(list.length, 20);
    assert.ok(list.every((p) => p.external_id));
  });

  it("routes v2 message by printer_external_id", () => {
    const reg = createPrinterRegistry();
    reg.syncFromWindowsList([
      { name: "Kitchen Printer 1" },
      { name: "Bar Printer" },
    ]);
    const hit = reg.routeMessage({ printer_external_id: "Bar Printer" });
    assert.equal(hit.ok, true);
    assert.equal(hit.printer.windows_name, "Bar Printer");
    assert.equal(hit.matchedBy, "external_id");
  });

  it("falls back to default when message has no printer_external_id", () => {
    const reg = createPrinterRegistry();
    reg.syncFromWindowsList([{ name: "A" }, { name: "B" }]);
    reg.setDefault("B");
    const hit = reg.routeMessage({});
    assert.equal(hit.ok, true);
    assert.equal(hit.printer.external_id, "B");
    assert.equal(hit.matchedBy, "default");
  });

  it("fails closed on unknown printer_external_id", () => {
    const reg = createPrinterRegistry();
    reg.syncFromWindowsList([{ name: "Kitchen" }]);
    const hit = reg.routeMessage({ printer_external_id: "Missing" });
    assert.equal(hit.ok, false);
    assert.equal(hit.reason, "unknown_printer_external_id");
  });

  it("serialize/hydrate round-trip", () => {
    const reg = createPrinterRegistry();
    reg.syncFromWindowsList([{ name: "X", portName: "USB001" }]);
    reg.setDefault("X");
    const data = reg.serialize();
    const reg2 = createPrinterRegistry();
    reg2.hydrate(data);
    assert.equal(reg2.list().length, 1);
    assert.equal(reg2.getDefault().external_id, "X");
  });
});
