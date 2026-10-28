"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const v = require("../src/lan-host-validation");

describe("lan-host-validation (BE v1.6 mirror)", () => {
  it("isIpv6Address matches FILTER_FLAG_IPV6 literals", () => {
    assert.equal(v.isIpv6Address("2001:db8::1"), true);
    assert.equal(v.isIpv6Address("::1"), true);
    assert.equal(v.isIpv6Address("[2001:db8::1]"), true);
    assert.equal(v.isIpv6Address("192.168.1.21"), false);
    assert.equal(v.isIpv6Address("printer.local"), false);
    assert.equal(v.isIpv6Address(""), false);
  });

  it("parsePortStrict rejects out of range and non-integers (no 9100 default)", () => {
    assert.equal(v.parsePortStrict("9100"), 9100);
    assert.equal(v.parsePortStrict("1"), 1);
    assert.equal(v.parsePortStrict("65535"), 65535);
    assert.equal(v.parsePortStrict("0"), null);
    assert.equal(v.parsePortStrict("65536"), null);
    assert.equal(v.parsePortStrict("99999"), null);
    assert.equal(v.parsePortStrict(""), null);
    assert.equal(v.parsePortStrict("91.5"), null);
    assert.equal(v.parsePortStrict("abc"), null);
  });

  it("validateManualLan rejects IPv6 and bad ports; keeps host+port for caller", () => {
    assert.equal(v.validateManualLan("2001:db8::1", "9100"), v.IPV6_ERROR);
    assert.equal(v.validateManualLan("10.0.0.5", "99999"), v.PORT_RANGE_ERROR);
    assert.equal(v.validateManualLan("10.0.0.5", ""), v.PORT_RANGE_ERROR);
    assert.equal(v.validateManualLan("", "9100"), v.HOST_REQUIRED_ERROR);
    assert.equal(v.validateManualLan("10.0.0.5", "9101"), null);
    assert.equal(v.validateManualLan("kitchen-printer", "9100"), null);
  });

  it("assertPrintHostCanAdd blocks observers", () => {
    assert.equal(v.assertPrintHostCanAdd(true), null);
    assert.equal(v.assertPrintHostCanAdd(false), v.NON_HOST_ADD_ERROR);
  });
});
