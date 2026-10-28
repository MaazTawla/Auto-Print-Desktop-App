"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeRabbitConfig,
  rabbitConfigToPersistPatch,
  shouldApplyBrokerCreds,
  rabbitConnectionFingerprint,
} = require("../src/agent-contract");

describe("rabbit server apply / manual override", () => {
  const rabbit = {
    host: "mq.example.com",
    port: 5672,
    vhost: "/print",
    username: "agent",
    password: "secret",
    exchange: "auto_print",
    routing_key: "orders.147",
    queue: "printer.Branch.147",
    queue_durable: true,
    queue_arguments: { "x-single-active-consumer": true },
    prefetch: 1,
  };

  it("shouldApplyBrokerCreds is false when override on", () => {
    assert.equal(shouldApplyBrokerCreds(false), true);
    assert.equal(shouldApplyBrokerCreds(true), false);
  });

  it("persist patch includes broker when override off", () => {
    const cfg = normalizeRabbitConfig(rabbit, 147);
    const patch = rabbitConfigToPersistPatch(cfg, { manualOverride: false });
    assert.equal(patch.rabbit_host, "mq.example.com");
    assert.equal(patch.rabbit_password, "secret");
    assert.equal(patch.rabbit_queue, "printer.Branch.147");
    assert.equal(patch.rabbit_vhost, "/print");
  });

  it("persist patch keeps queue but skips broker when override on", () => {
    const cfg = normalizeRabbitConfig(rabbit, 147);
    const patch = rabbitConfigToPersistPatch(cfg, { manualOverride: true });
    assert.equal(patch.rabbit_queue, "printer.Branch.147");
    assert.equal(patch.rabbit_host, undefined);
    assert.equal(patch.rabbit_password, undefined);
    assert.equal(patch.rabbit_username, undefined);
    assert.equal(patch.rabbit_exchange, undefined);
    assert.equal(patch.rabbit_routing_key, undefined);
    assert.equal(patch.rabbit_vhost, "/print");
  });

  it("fingerprint changes when host changes", () => {
    const a = rabbitConnectionFingerprint({ rabbit_host: "a", branch_id: "1" });
    const b = rabbitConnectionFingerprint({ rabbit_host: "b", branch_id: "1" });
    assert.notEqual(a, b);
  });
});
