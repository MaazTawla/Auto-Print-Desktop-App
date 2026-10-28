"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { createHostOnlyPolicy } = require("../src/host-only-policy");

describe("HostOnlyPolicy", () => {
  it("does not consume until server says is_print_host", () => {
    const p = createHostOnlyPolicy();
    assert.equal(p.shouldConsume(), false);
    const r = p.applyServerState({ is_print_host: true, host_epoch: 1 });
    assert.equal(r.promoted, true);
    assert.equal(p.shouldConsume(), true);
  });

  it("stops consuming on revoke", () => {
    const p = createHostOnlyPolicy({ isPrintHost: true, hostEpoch: 2 });
    const r = p.applyServerState({ is_print_host: false, host_epoch: 3 });
    assert.equal(r.revoked, true);
    assert.equal(p.shouldConsume(), false);
  });

  it("revokes when host_epoch bumps while host", () => {
    const p = createHostOnlyPolicy({ isPrintHost: true, hostEpoch: 5, knownEpoch: 5 });
    const r = p.applyServerState({ is_print_host: false, host_epoch: 6 });
    assert.equal(r.revoked, true);
    assert.equal(p.hostEpoch, 6);
    assert.equal(p.shouldConsume(), false);
  });

  it("nacks messages when not host", () => {
    const p = createHostOnlyPolicy({ isPrintHost: false, hostEpoch: 1 });
    const d = p.decideMessage({ host_epoch: 1, printer_external_id: "p1" });
    assert.equal(d.action, "nack");
    assert.equal(d.reason, "not_print_host");
  });

  it("nacks stray messages with mismatched host_epoch", () => {
    const p = createHostOnlyPolicy({ isPrintHost: true, hostEpoch: 4 });
    const d = p.decideMessage({ host_epoch: 3, printer_external_id: "kitchen" });
    assert.equal(d.action, "nack");
    assert.equal(d.reason, "host_epoch_mismatch");
  });

  it("allows print when host and epoch matches", () => {
    const p = createHostOnlyPolicy({ isPrintHost: true, hostEpoch: 4 });
    const d = p.decideMessage({ host_epoch: 4, printer_external_id: "kitchen" });
    assert.equal(d.action, "print");
  });

  it("manual revoke clears consume", () => {
    const p = createHostOnlyPolicy({ isPrintHost: true, hostEpoch: 1 });
    const r = p.revoke("conflict");
    assert.equal(r.revoked, true);
    assert.equal(p.shouldConsume(), false);
  });
});
