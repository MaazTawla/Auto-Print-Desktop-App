"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { createPrinterRegistry } = require("../src/printer-registry");

describe("printer-registry", () => {
  it("syncs Windows list with win:{name} external_id and no cap", () => {
    const reg = createPrinterRegistry();
    const many = [];
    for (let i = 0; i < 20; i++) {
      many.push({ name: `Printer ${i}`, portName: `USB00${i}` });
    }
    const list = reg.syncFromWindowsList(many);
    assert.equal(list.length, 20);
    assert.ok(list.every((p) => p.external_id.startsWith("win:")));
    assert.equal(list[0].external_id, "win:Printer 0");
  });

  it("routes v2 message by win: printer_external_id", () => {
    const reg = createPrinterRegistry();
    reg.syncFromWindowsList([
      { name: "Kitchen Printer 1" },
      { name: "Bar Printer" },
    ]);
    const hit = reg.routeMessage({ printer_external_id: "win:Bar Printer" });
    assert.equal(hit.ok, true);
    assert.equal(hit.printer.windows_name, "Bar Printer");
    assert.equal(hit.matchedBy, "external_id");
  });

  it("routes bare Windows name via win: normalization", () => {
    const reg = createPrinterRegistry();
    reg.syncFromWindowsList([{ name: "Bar Printer" }]);
    const hit = reg.routeMessage({ printer_external_id: "Bar Printer" });
    assert.equal(hit.ok, true);
    assert.equal(hit.matchedBy, "external_id");
    assert.equal(hit.printer.external_id, "win:Bar Printer");
  });

  it("falls back to default when message has no printer_external_id", () => {
    const reg = createPrinterRegistry();
    reg.syncFromWindowsList([{ name: "A" }, { name: "B" }]);
    reg.setDefault("B");
    const hit = reg.routeMessage({});
    assert.equal(hit.ok, true);
    assert.equal(hit.printer.external_id, "win:B");
    assert.equal(hit.matchedBy, "default");
  });

  it("fails closed on unknown printer_external_id", () => {
    const reg = createPrinterRegistry();
    reg.syncFromWindowsList([{ name: "Kitchen" }]);
    const hit = reg.routeMessage({ printer_external_id: "Missing" });
    assert.equal(hit.ok, false);
    assert.equal(hit.reason, "unknown_printer_external_id");
  });

  it("applyServerSync stores server-assigned ids by external_id", () => {
    const reg = createPrinterRegistry();
    reg.syncFromWindowsList([{ name: "Kitchen" }, { name: "Bar" }]);
    reg.applyServerSync([
      { id: 42, external_id: "win:Kitchen", name: "Kitchen", connection_type: "usb" },
      { id: 43, external_id: "win:Bar", name: "Bar", connection_type: "lan" },
    ]);
    assert.equal(reg.get("win:Kitchen").server_id, 42);
    assert.equal(reg.getByServerId(43).external_id, "win:Bar");
  });

  it("serialize/hydrate round-trip keeps server_id", () => {
    const reg = createPrinterRegistry();
    reg.syncFromWindowsList([{ name: "X", portName: "USB001" }]);
    reg.applyServerSync([{ id: 99, external_id: "win:X", name: "X" }]);
    reg.setDefault("win:X");
    const data = reg.serialize();
    const reg2 = createPrinterRegistry();
    reg2.hydrate(data);
    assert.equal(reg2.list().length, 1);
    assert.equal(reg2.getDefault().external_id, "win:X");
    assert.equal(reg2.get("win:X").server_id, 99);
  });

  it("infers optional ip/port for network Windows ports", () => {
    const reg = createPrinterRegistry();
    const list = reg.syncFromWindowsList([
      { name: "LAN Kitchen", portName: "IP_192.168.1.21" },
    ]);
    assert.equal(list[0].external_id, "win:LAN Kitchen");
    assert.equal(list[0].ip_address, "192.168.1.21");
    assert.equal(list[0].port, 9100);
    const payload = reg.toSyncPayload();
    assert.equal(payload[0].ip_address, "192.168.1.21");
    assert.equal(payload[0].port, 9100);
  });
});

describe("printer-registry scan-first prune", () => {
  it("keeps lan: scan adds when Windows list refreshes", () => {
    const { createPrinterRegistry } = require("../src/printer-registry");
    const reg = createPrinterRegistry();
    reg.upsert({
      external_id: "lan:10.0.0.9:9100",
      name: "Network 10.0.0.9",
      connection: "lan",
      ip_address: "10.0.0.9",
      port: 9100,
    });
    reg.upsert({
      external_id: "win:Old USB",
      name: "Old USB",
      windows_name: "Old USB",
      connection: "usb",
    });
    reg.syncFromWindowsList([{ name: "New USB", portName: "USB001" }]);
    const ids = reg.list().map((p) => p.external_id);
    assert.ok(ids.includes("lan:10.0.0.9:9100"), "lan scan add must survive Windows refresh");
    assert.ok(!ids.includes("win:Old USB"), "missing win: row should be pruned");
    assert.ok(ids.some((id) => /^win:/i.test(id) && /New USB/i.test(id)));
  });
});

describe("printer-registry remove + edit replace", () => {
  it("remove drops a printer and promotes a new default", () => {
    const reg = createPrinterRegistry();
    reg.upsert({
      external_id: "lan:10.0.0.1:9100",
      name: "Kitchen",
      connection: "lan",
      is_default: true,
      ip_address: "10.0.0.1",
      port: 9100,
    });
    reg.upsert({
      external_id: "lan:10.0.0.2:9100",
      name: "Bar",
      connection: "lan",
      ip_address: "10.0.0.2",
      port: 9100,
    });
    const removed = reg.remove("lan:10.0.0.1:9100");
    assert.equal(removed.name, "Kitchen");
    assert.equal(reg.list().length, 1);
    assert.equal(reg.getDefault().external_id, "lan:10.0.0.2:9100");
    assert.equal(reg.getDefault().is_default, true);
  });

  it("remove of last printer yields empty registry", () => {
    const reg = createPrinterRegistry();
    reg.upsert({
      external_id: "lan:10.0.0.1:9100",
      name: "Kitchen",
      connection: "lan",
      is_default: true,
    });
    reg.remove("lan:10.0.0.1:9100");
    assert.equal(reg.list().length, 0);
    assert.equal(reg.getDefault(), null);
  });

  it("edit replace drops old lan eid when host/port changes", () => {
    const reg = createPrinterRegistry();
    reg.upsert({
      external_id: "lan:10.0.0.1:9100",
      name: "Kitchen",
      connection: "lan",
      is_default: true,
      ip_address: "10.0.0.1",
      port: 9100,
    });
    reg.remove("lan:10.0.0.1:9100");
    reg.upsert({
      external_id: "lan:10.0.0.9:9101",
      name: "Kitchen",
      connection: "lan",
      is_default: true,
      ip_address: "10.0.0.9",
      port: 9101,
    });
    const ids = reg.list().map((p) => p.external_id);
    assert.deepEqual(ids, ["lan:10.0.0.9:9101"]);
  });
});


describe("R20D registry external_id boundary", () => {
  const { capExternalId, codePointLength } = require("../src/printer-field-limits");

  it("R20D-M1: long Windows printer keeps server_id, custom name, default across sync", () => {
    const name = "P".repeat(252);
    const reg = createPrinterRegistry();
    reg.syncFromWindowsList([{ name }]);
    assert.equal(reg.list().length, 1);
    const eid = reg.list()[0].external_id;
    assert.equal(codePointLength(eid), 255);
    reg.upsert({
      external_id: eid,
      name: "Front Counter",
      server_id: 77,
      is_default: true,
      windows_name: name,
    });
    reg.syncFromWindowsList([{ name }]);
    assert.equal(reg.list().length, 1);
    const row = reg.list()[0];
    assert.equal(row.server_id, 77);
    assert.equal(row.name, "Front Counter");
    assert.equal(row.is_default, true);
    assert.equal(row.external_id, eid);
    // Dropping the printer from Windows list should still prune by capped id
    reg.syncFromWindowsList([]);
    assert.equal(reg.list().length, 0);
  });

  it("R20D-M2: hydrate migrates legacy over-255 default and aliases", () => {
    const raw = "win:" + "Q".repeat(300);
    const capped = capExternalId(raw);
    const reg = createPrinterRegistry();
    reg.hydrate({
      printers: [
        { external_id: raw, name: "Legacy" },
        { external_id: "win:Other", name: "Other" },
      ],
      defaultExternalId: raw,
      eidAliases: { [raw]: "win:Other" },
    });
    assert.equal(reg.serialize().defaultExternalId, capped);
    assert.equal(reg.getDefault().name, "Legacy");
    // Alias values are capped; legacy raw keys may remain for lookup.
    const aliases = reg.serialize().eidAliases || {};
    assert.ok(Object.keys(aliases).length > 0);
    assert.ok(
      Object.values(aliases).every((v) => codePointLength(String(v)) <= 255)
    );
    assert.equal(aliases[capped.toLowerCase()], "win:Other");
    const route = reg.routeMessage({});
    assert.equal(route.ok, true);
    assert.equal(route.printer.name, "Legacy");
  });

  it("upsert always caps external_id at the boundary", () => {
    const raw = "lan:" + "h".repeat(280) + ":9100";
    const reg = createPrinterRegistry();
    const row = reg.upsert({ external_id: raw, name: "LongHost" });
    assert.equal(row.external_id, capExternalId(raw));
    assert.notEqual(row.external_id, raw);
  });
});
