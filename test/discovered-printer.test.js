"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const dp = require("../src/discovered-printer");

describe("discovered-printer", () => {
  it("builds lan and bt external ids", () => {
    assert.equal(dp.lanExternalId("10.0.0.5"), "lan:10.0.0.5:9100");
    assert.equal(dp.lanExternalId("10.0.0.5", 9101), "lan:10.0.0.5:9101");
    assert.equal(dp.btExternalId("aa:bb:cc:dd:ee:ff"), "bt:AA:BB:CC:DD:EE:FF");
  });

  it("maps Windows spooler row to win: candidate", () => {
    const c = dp.fromWindowsPrinter({ name: "EPSON TM", portName: "USB001" });
    assert.ok(c);
    assert.equal(c.connection, "usb");
    assert.equal(c.typeLabel, "USB");
    assert.match(c.externalId, /^win:/i);
    assert.equal(c.windows_name, "EPSON TM");
  });

  it("maps LAN hit", () => {
    const c = dp.fromLan({ host: "192.168.1.20", port: 9100 });
    assert.equal(c.externalId, "lan:192.168.1.20:9100");
    assert.equal(c.connection, "lan");
    assert.equal(c.typeLabel, "LAN");
    assert.equal(c.host, "192.168.1.20");
  });

  it("merge dedupes by external_id and orders USB before LAN", () => {
    const list = dp.merge({
      windows: [
        { name: "Kitchen", portName: "USB001" },
        { name: "Kitchen", portName: "USB001" },
      ],
      lan: [{ host: "10.0.0.8", port: 9100 }],
    });
    const ids = list.map((c) => c.externalId.toLowerCase());
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(list[0].connection, "usb");
    assert.ok(list.some((c) => c.connection === "lan"));
  });

  it("isAlreadyAdded matches external_id and LAN host/port", () => {
    const lan = dp.fromLan({ host: "10.0.0.1", port: 9100 });
    assert.equal(
      dp.isAlreadyAdded(lan, [{ external_id: "lan:10.0.0.1:9100" }]),
      true
    );
    assert.equal(
      dp.isAlreadyAdded(lan, [
        { connection: "lan", ip_address: "10.0.0.1", port: 9100 },
      ]),
      true
    );
    assert.equal(dp.isAlreadyAdded(lan, []), false);
  });

  it("toRegistryPrinter produces upsertable row", () => {
    const row = dp.toRegistryPrinter(dp.fromLan({ host: "10.0.0.2", port: 9100 }), {
      makeDefault: true,
    });
    assert.equal(row.external_id, "lan:10.0.0.2:9100");
    assert.equal(row.connection, "lan");
    assert.equal(row.ip_address, "10.0.0.2");
    assert.equal(row.port, 9100);
    assert.equal(row.is_default, true);
  });
});
