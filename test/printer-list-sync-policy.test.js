"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  configHash,
  statusFingerprint,
  shouldSkipUnchanged,
  shouldLogHeartbeatFailure,
} = require("../src/printer-list-sync-policy");

describe("printer-list-sync-policy", () => {
  it("configHash ignores status changes", () => {
    const a = [{ external_id: "lan:1", name: "A", connection_type: "lan", status: "online", ip_address: "1.1.1.1", port: 9100 }];
    const b = [{ external_id: "lan:1", name: "A", connection_type: "lan", status: "offline", status_detail: "down", ip_address: "1.1.1.1", port: 9100 }];
    assert.equal(configHash(a), configHash(b));
    assert.notEqual(statusFingerprint(a), statusFingerprint(b));
  });

  it("shouldSkipUnchanged when hash matches", () => {
    assert.equal(shouldSkipUnchanged("abc", "abc"), true);
    assert.equal(shouldSkipUnchanged("abc", "abc", { forceEmpty: true }), false);
    assert.equal(shouldSkipUnchanged("abc", "", {}), false);
  });

  it("heartbeat failure log throttles", () => {
    assert.equal(shouldLogHeartbeatFailure(0), false);
    assert.equal(shouldLogHeartbeatFailure(1), true);
    assert.equal(shouldLogHeartbeatFailure(2), false);
    assert.equal(shouldLogHeartbeatFailure(3), true);
  });
});

  it("is_default changes the configHash (M2)", () => {
    const base = {
      external_id: "lan:1",
      name: "A",
      connection_type: "lan",
      status: "online",
      ip_address: "1.1.1.1",
      port: 9100,
      model: "X",
    };
    const a = [{ ...base, is_default: false }];
    const b = [{ ...base, is_default: true }];
    assert.notEqual(configHash(a), configHash(b));
    // isDefault camelCase alias also counts
    const c = [{ ...base, isDefault: true }];
    assert.equal(configHash(b), configHash(c));
  });

  it("heartbeatFailureRetryMs caps at 20s", () => {
    const { heartbeatFailureRetryMs } = require("../src/printer-list-sync-policy");
    assert.equal(heartbeatFailureRetryMs(1), 5000);
    assert.equal(heartbeatFailureRetryMs(4), 20000);
  });

