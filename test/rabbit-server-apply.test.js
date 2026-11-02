"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeRabbitConfig,
  rabbitConfigToPersistPatch,
  shouldApplyBrokerCreds,
  rabbitConnectionFingerprint,
  isLoopbackOrUnspecifiedHost,
  resolveBrokerHost,
  normalizeAgentApiBase,
  resolveApiUrl,
  defaultPortForTls,
  parseHeartbeatResponse,
  buildHeartbeatRequest,
  parseRegisterResponse,
  parseRabbitVersionSignal,
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

describe("loopback rabbit host rewrite", () => {
  it("detects loopback and unspecified", () => {
    assert.equal(isLoopbackOrUnspecifiedHost("127.0.0.1"), true);
    assert.equal(isLoopbackOrUnspecifiedHost("127.1.2.3"), true);
    assert.equal(isLoopbackOrUnspecifiedHost("localhost"), true);
    assert.equal(isLoopbackOrUnspecifiedHost("::1"), true);
    assert.equal(isLoopbackOrUnspecifiedHost("0.0.0.0"), true);
    assert.equal(isLoopbackOrUnspecifiedHost("192.168.1.10"), false);
  });

  it("rewrites loopback when Server URL host is not loopback", () => {
    const r = resolveBrokerHost("127.0.0.1", "http://192.168.1.10:8000", false);
    assert.equal(r.host, "192.168.1.10");
    assert.match(r.rewriteNote, /192\.168\.1\.10/);
  });

  it("keeps loopback when both are loopback (same machine)", () => {
    const r = resolveBrokerHost("127.0.0.1", "http://127.0.0.1:8000", false);
    assert.equal(r.host, "127.0.0.1");
    assert.equal(r.rewriteNote, null);
  });

  it("skips rewrite when manual override on", () => {
    const r = resolveBrokerHost("127.0.0.1", "http://192.168.1.10:8000", true);
    assert.equal(r.host, "127.0.0.1");
    assert.equal(r.rewriteNote, null);
  });

  it("normalizeRabbitConfig applies rewrite via opts", () => {
    const cfg = normalizeRabbitConfig(
      { host: "127.0.0.1", port: 5672, username: "guest", password: "guest" },
      147,
      { apiBaseUrl: "http://10.0.0.5:8000", manualOverride: false }
    );
    assert.equal(cfg.host, "10.0.0.5");
    assert.ok(cfg.hostRewriteNote);
  });
});

describe("v1.7 rabbit tls + version", () => {
  it("tls true defaults port 5671", () => {
    assert.equal(defaultPortForTls(true), 5671);
    const cfg = normalizeRabbitConfig({ host: "mq", tls: true }, 1);
    assert.equal(cfg.port, 5671);
    assert.equal(cfg.tls, true);
    assert.equal(cfg.protocol, "amqps");
  });

  it("tls false defaults port 5672", () => {
    const cfg = normalizeRabbitConfig({ host: "mq", tls: false }, 1);
    assert.equal(cfg.port, 5672);
    assert.equal(cfg.protocol, "amqp");
  });

  it("persist patch includes rabbit_tls", () => {
    const cfg = normalizeRabbitConfig({ host: "mq", tls: true, port: 5671 }, 1);
    const patch = rabbitConfigToPersistPatch(cfg, { manualOverride: false });
    assert.equal(patch.rabbit_tls, true);
  });

  it("register parse keeps rabbit_version", () => {
    const parsed = parseRegisterResponse({
      token: "t",
      is_print_host: true,
      host_epoch: 2,
      branch_id: 147,
      rabbit_version: "abcdef0123456789",
      rabbit: { host: "mq", port: 5672, tls: false },
    });
    assert.equal(parsed.rabbit_version, "abcdef0123456789");
  });

  it("heartbeat request includes rabbit_version when set", () => {
    const body = buildHeartbeatRequest({
      appId: "a",
      branchId: "1",
      printers: [],
      rabbitVersion: "abcdef0123456789",
    });
    assert.equal(body.rabbit_version, "abcdef0123456789");
  });

  it("heartbeat response parses rabbit when present (stale)", () => {
    const hb = parseHeartbeatResponse({
      is_print_host: true,
      host_epoch: 1,
      rabbit_version: "bbbbbbbbbbbbbbbb",
      rabbit: { host: "new.mq", port: 5671, tls: true, queue: "printer.Branch.1" },
    });
    assert.equal(hb.rabbit_version, "bbbbbbbbbbbbbbbb");
    assert.equal(hb.rabbit.host, "new.mq");
    assert.equal(hb.rabbitConfig.port, 5671);
  });

  it("heartbeat response omits rabbitConfig when rabbit absent (match)", () => {
    const hb = parseHeartbeatResponse({
      is_print_host: true,
      host_epoch: 1,
      rabbit_version: "aaaaaaaaaaaaaaaa",
    });
    assert.equal(hb.rabbit_version, "aaaaaaaaaaaaaaaa");
    assert.equal(hb.rabbit, null);
    assert.equal(hb.rabbitConfig, null);
  });
});

describe("normalizeAgentApiBase / resolveApiUrl (M1)", () => {
  it("strips trailing /api/v1/print-agent", () => {
    assert.equal(
      normalizeAgentApiBase("https://api.example.com/api/v1/print-agent"),
      "https://api.example.com"
    );
    assert.equal(
      normalizeAgentApiBase("https://api.example.com/api/v1/print-agent/"),
      "https://api.example.com"
    );
  });

  it("does not double the print-agent path", () => {
    const url = resolveApiUrl(
      "https://api.example.com/api/v1/print-agent",
      "/register"
    );
    assert.equal(url, "https://api.example.com/api/v1/print-agent/register");
    assert.equal(url.includes("/print-agent/api/v1/print-agent"), false);
  });

  it("origin-only base still joins prefix", () => {
    assert.equal(
      resolveApiUrl("https://api.example.com", "/register"),
      "https://api.example.com/api/v1/print-agent/register"
    );
  });

  it("preserves /merchant mount path on subpath installs", () => {
    assert.equal(
      resolveApiUrl("https://dev.tawla.io/merchant", "/register"),
      "https://dev.tawla.io/merchant/api/v1/print-agent/register"
    );
    assert.equal(
      resolveApiUrl("https://dev.tawla.io/merchant/", "/api/v1/print-agent/register"),
      "https://dev.tawla.io/merchant/api/v1/print-agent/register"
    );
    assert.equal(
      resolveApiUrl("https://dev.tawla.io/merchant", "/api/v1/print-agent/heartbeat"),
      "https://dev.tawla.io/merchant/api/v1/print-agent/heartbeat"
    );
  });
});

describe("v1.8 parseRabbitVersionSignal", () => {
  it("missing key → keep", () => {
    const s = parseRabbitVersionSignal({ is_print_host: true });
    assert.equal(s.action, "keep");
    assert.equal(s.version, null);
  });
  it("explicit null → clear", () => {
    const s = parseRabbitVersionSignal({ rabbit_version: null });
    assert.equal(s.action, "clear");
    assert.equal(s.version, null);
  });
  it("string → set", () => {
    const s = parseRabbitVersionSignal({ rabbit_version: "abcdef0123456789" });
    assert.equal(s.action, "set");
    assert.equal(s.version, "abcdef0123456789");
  });
  it("heartbeat parse exposes action", () => {
    const clear = parseHeartbeatResponse({
      is_print_host: false,
      host_epoch: 2,
      rabbit_version: null,
    });
    assert.equal(clear.rabbit_version_action, "clear");
    const keep = parseHeartbeatResponse({
      is_print_host: true,
      host_epoch: 2,
    });
    assert.equal(keep.rabbit_version_action, "keep");
  });
});
