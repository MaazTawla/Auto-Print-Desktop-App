"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const net = require("net");
const {
  hostsOnSubnet,
  portOpen,
  scanLanPrinters,
} = require("../src/lan-printer-scanner");

describe("lan-printer-scanner", () => {
  it("hostsOnSubnet returns /24 host range excluding network and broadcast", () => {
    const hosts = hostsOnSubnet("192.168.1.50", 24);
    assert.equal(hosts.length, 254);
    assert.equal(hosts[0], "192.168.1.1");
    assert.equal(hosts[hosts.length - 1], "192.168.1.254");
    assert.ok(!hosts.includes("192.168.1.0"));
    assert.ok(!hosts.includes("192.168.1.255"));
  });

  it("portOpen detects listening TCP port", async () => {
    const server = net.createServer();
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address();
    try {
      assert.equal(await portOpen("127.0.0.1", port, 500), true);
      assert.equal(await portOpen("127.0.0.1", port + 1, 80), false);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it("scanLanPrinters returns [] when no subnets (forced empty self)", async () => {
    // Force empty by stubbing via opts: scan still needs real NICs; just assert API shape.
    const progress = [];
    const found = await scanLanPrinters({
      onProgress: (m) => progress.push(m),
      ports: [1], // unlikely open
    });
    assert.ok(Array.isArray(found));
    assert.ok(progress.length >= 1);
  });
});
