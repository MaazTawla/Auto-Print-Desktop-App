"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  createPrinterRegistry,
  migrateEidAlias,
  resolveEidAlias,
} = require("../src/printer-registry");
const { createStationPrintingController } = require("../src/station-printing");

describe("printer eid replace — M1 collision + M2 alias migrate", () => {
  it("migrateEidAlias rewrites chains", () => {
    const a = migrateEidAlias({}, "lan:10.0.0.1:9100", "lan:10.0.0.2:9100");
    assert.equal(a["lan:10.0.0.1:9100"], "lan:10.0.0.2:9100");
    const b = migrateEidAlias(a, "lan:10.0.0.2:9100", "lan:10.0.0.3:9100");
    assert.equal(b["lan:10.0.0.1:9100"], "lan:10.0.0.3:9100");
    assert.equal(resolveEidAlias("lan:10.0.0.1:9100", b), "lan:10.0.0.3:9100");
  });

  it("replaceExternalId rejects collision with clear error", () => {
    const reg = createPrinterRegistry();
    reg.upsert({
      external_id: "lan:10.0.0.1:9100",
      name: "Kitchen",
      connection: "lan",
      ip_address: "10.0.0.1",
      port: 9100,
      is_default: true,
      server_id: 7,
    });
    reg.upsert({
      external_id: "lan:10.0.0.2:9100",
      name: "Bar",
      connection: "lan",
      ip_address: "10.0.0.2",
      port: 9100,
    });
    const bad = reg.replaceExternalId("lan:10.0.0.1:9100", {
      external_id: "lan:10.0.0.2:9100",
      name: "Kitchen Moved",
      connection: "lan",
      ip_address: "10.0.0.2",
      port: 9100,
      is_default: true,
    });
    assert.equal(bad.ok, false);
    assert.equal(bad.code, "EID_COLLISION");
    assert.match(bad.error, /Printer already exists at/);
    assert.equal(reg.list().length, 2);
  });

  it("replaceExternalId migrates alias, carries server_id, routes old eid", () => {
    const reg = createPrinterRegistry();
    reg.upsert({
      external_id: "lan:10.0.0.1:9100",
      name: "Kitchen",
      connection: "lan",
      ip_address: "10.0.0.1",
      port: 9100,
      is_default: true,
      server_id: 42,
    });
    const ok = reg.replaceExternalId("lan:10.0.0.1:9100", {
      external_id: "lan:10.0.0.9:9101",
      name: "Kitchen",
      connection: "lan",
      ip_address: "10.0.0.9",
      port: 9101,
      is_default: true,
    });
    assert.equal(ok.ok, true);
    assert.equal(reg.list().length, 1);
    assert.equal(reg.list()[0].external_id, "lan:10.0.0.9:9101");
    assert.equal(reg.list()[0].server_id, 42);
    assert.equal(reg.getEidAliases()["lan:10.0.0.1:9100"], "lan:10.0.0.9:9101");
    const routed = reg.routeMessage({ printer_external_id: "lan:10.0.0.1:9100" });
    assert.equal(routed.ok, true);
    assert.equal(routed.printer.external_id, "lan:10.0.0.9:9101");
  });

  it("upsertManagedPrinter surfaces collision", () => {
    const sp = createStationPrintingController({
      readConfig: () => ({
        agent_token: "t",
        api_base_url: "https://example.test",
        branch_id: "1",
        app_id: "app",
        is_print_host: true,
        pairing_code: "",
      }),
      writeConfig: () => {},
      api: {
        getToken: () => "t",
        syncPrinters: async () => ({ ok: true, printers: [] }),
      },
      log: () => {},
      onStateChange: () => {},
      persistHostFlags: () => {},
    });
    sp.upsertManagedPrinter({
      external_id: "lan:10.0.0.1:9100",
      name: "Kitchen",
      connection: "lan",
      ip_address: "10.0.0.1",
      port: 9100,
      is_default: true,
    });
    sp.upsertManagedPrinter({
      external_id: "lan:10.0.0.2:9100",
      name: "Bar",
      connection: "lan",
      ip_address: "10.0.0.2",
      port: 9100,
    });
    const up = sp.upsertManagedPrinter(
      {
        external_id: "lan:10.0.0.2:9100",
        name: "Kitchen Moved",
        connection: "lan",
        ip_address: "10.0.0.2",
        port: 9100,
        is_default: true,
      },
      { replaceExternalId: "lan:10.0.0.1:9100" },
    );
    assert.equal(up.ok, false);
    assert.match(up.error, /Printer already exists at/);
    assert.equal(sp.printers.list().length, 2);
  });
});
