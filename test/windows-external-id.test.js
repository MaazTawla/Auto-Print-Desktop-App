"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  windowsPrinterExternalId,
  inferNetworkEndpointFromWindowsPrinter,
} = require("../src/windows-external-id");

describe("windows-external-id", () => {
  it("formats win:{Windows printer name}", () => {
    assert.equal(windowsPrinterExternalId("Kitchen Printer 1"), "win:Kitchen Printer 1");
    assert.equal(windowsPrinterExternalId("win:Already"), "win:Already");
    assert.equal(windowsPrinterExternalId("  "), "");
  });

  it("infers network endpoint from portName", () => {
    const a = inferNetworkEndpointFromWindowsPrinter({ portName: "IP_10.0.0.5" });
    assert.deepEqual(a, { ip_address: "10.0.0.5", port: 9100 });
    const b = inferNetworkEndpointFromWindowsPrinter({ portName: "192.168.1.9_9100" });
    assert.equal(b.ip_address, "192.168.1.9");
    assert.equal(b.port, 9100);
    assert.equal(inferNetworkEndpointFromWindowsPrinter({ portName: "USB001" }), null);
  });
});
