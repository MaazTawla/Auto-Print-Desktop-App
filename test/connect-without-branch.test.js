"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { createStationPrintingController } = require("../src/station-printing");

describe("H1 Connect without local Branch ID", () => {
  it("registerAsHost succeeds with pairing + empty branch_id and persists server branch + clears pairing", async () => {
    let cfg = {
      agent_api_base: "https://api.example.com",
      pairing_code: "PAIR-1234",
      device_label: "Test Desktop",
      rabbit_manual_override: false,
      // intentionally no branch_id
    };
    const calls = [];
    const controller = createStationPrintingController({
      readConfig: () => ({ ...cfg }),
      writeConfig: (patch) => {
        cfg = { ...cfg, ...patch };
      },
      log: () => {},
      request: async (req) => {
        calls.push(req);
        if (String(req.url).includes("/register")) {
          assert.equal(req.data.pairing_code, "PAIR-1234");
          assert.ok(req.data.branch_id == null || req.data.branch_id === "");
          return {
            status: 200,
            data: {
              token: "tok_abc",
              is_print_host: true,
              host_epoch: 3,
              branch_id: 147,
              rabbit_version: "abcdef0123456789",
              rabbit: {
                host: "127.0.0.1",
                port: 5672,
                tls: false,
                vhost: "/",
                username: "guest",
                password: "guest",
                exchange: "auto_print",
                exchange_type: "topic",
                routing_key: "orders.147",
                queue: "printer.Branch.147",
                queue_durable: true,
                queue_arguments: { "x-single-active-consumer": true },
                consume_exclusive: false,
                prefetch: 1,
              },
            },
          };
        }
        return { status: 404, data: { error: { message: "unexpected " + req.url } } };
      },
    });

    const result = await controller.registerAsHost({});
    assert.equal(result.ok, true);
    assert.equal(result.shouldConsume, true);
    assert.equal(String(cfg.branch_id), "147");
    assert.equal(cfg.agent_token, "tok_abc");
    assert.equal(cfg.rabbit_version, "abcdef0123456789");
    // loopback rewritten to Server URL host
    assert.equal(cfg.rabbit_host, "api.example.com");
    // L2: pairing cleared from disk after success
    assert.equal(cfg.pairing_code, "");
    assert.ok(cfg.last_server_rabbit);
    assert.equal(calls.length, 1);
  });

  it("heartbeat applies rabbit when version stale and stores new version", async () => {
    let cfg = {
      agent_api_base: "https://api.example.com",
      agent_token: "tok",
      branch_id: "147",
      rabbit_version: "aaaaaaaaaaaaaaaa",
      rabbit_host: "old.mq",
      rabbit_port: 5672,
      rabbit_manual_override: false,
      is_print_host: true,
      host_epoch: 1,
    };
    const controller = createStationPrintingController({
      readConfig: () => ({ ...cfg }),
      writeConfig: (patch) => {
        cfg = { ...cfg, ...patch };
      },
      log: () => {},
      request: async (req) => {
        if (String(req.url).includes("/heartbeat")) {
          assert.equal(req.data.rabbit_version, "aaaaaaaaaaaaaaaa");
          return {
            status: 200,
            data: {
              is_print_host: true,
              host_epoch: 1,
              pending_job_count: 0,
              rabbit_version: "bbbbbbbbbbbbbbbb",
              rabbit: {
                host: "new.mq",
                port: 5672,
                tls: false,
                username: "agent",
                password: "secret",
                exchange: "auto_print",
                queue: "printer.Branch.147",
              },
            },
          };
        }
        return { status: 404, data: {} };
      },
    });
    controller.api.setToken("tok");
    const live = await controller.heartbeat({ branchId: "147" });
    assert.equal(live.ok, true);
    assert.equal(live.rabbitChanged, true);
    assert.equal(cfg.rabbit_version, "bbbbbbbbbbbbbbbb");
    assert.equal(cfg.rabbit_host, "new.mq");
  });

  it("override off restores last_server_rabbit", () => {
    let cfg = {
      rabbit_manual_override: true,
      rabbit_host: "manual.local",
      rabbit_port: 5673,
      agent_api_base: "https://api.example.com",
      branch_id: "147",
      last_server_rabbit: {
        host: "mq.example.com",
        port: 5672,
        tls: false,
        username: "agent",
        password: "secret",
        exchange: "auto_print",
        queue: "printer.Branch.147",
      },
    };
    const controller = createStationPrintingController({
      readConfig: () => ({ ...cfg }),
      writeConfig: (patch) => {
        cfg = { ...cfg, ...patch };
      },
      log: () => {},
    });
    const res = controller.setRabbitManualOverride(false);
    assert.equal(res.ok, true);
    assert.equal(res.rabbitManualOverride, false);
    assert.equal(res.rabbitChanged, true);
    assert.equal(cfg.rabbit_host, "mq.example.com");
    assert.equal(cfg.rabbit_manual_override, false);
  });
});

describe("host-only Rabbit credentials", () => {
  it("non-host register without rabbit does not wipe stored broker and does not consume", async () => {
    let cfg = {
      agent_api_base: "https://api.example.com",
      pairing_code: "PAIR",
      rabbit_host: "old.mq",
      rabbit_password: "oldsecret",
      rabbit_manual_override: false,
    };
    const controller = createStationPrintingController({
      readConfig: () => ({ ...cfg }),
      writeConfig: (patch) => {
        cfg = { ...cfg, ...patch };
      },
      log: () => {},
      request: async () => ({
        status: 200,
        data: {
          token: "tok_obs",
          is_print_host: false,
          host_epoch: 1,
          branch_id: 147,
          rabbit_version: "aaaaaaaaaaaaaaaa",
          // no rabbit object
        },
      }),
    });
    const result = await controller.registerAsHost({});
    assert.equal(result.ok, true);
    assert.equal(result.shouldConsume, false);
    // absence must not wipe
    assert.equal(cfg.rabbit_host, "old.mq");
    assert.equal(cfg.rabbit_password, "oldsecret");
    assert.equal(cfg.pairing_code, "");
  });

  it("409 conflict drops broker credentials", async () => {
    let cfg = {
      agent_api_base: "https://api.example.com",
      pairing_code: "PAIR",
      rabbit_host: "mq.example.com",
      rabbit_password: "secret",
      rabbit_version: "aaaaaaaaaaaaaaaa",
    };
    const controller = createStationPrintingController({
      readConfig: () => ({ ...cfg }),
      writeConfig: (patch) => {
        cfg = { ...cfg, ...patch };
      },
      log: () => {},
      request: async () => ({
        status: 409,
        data: {
          error: {
            code: "PRINT_HOST_ALREADY_CONFIGURED",
            message: "Another device is print host",
            current_host: { app_id: "other", device_label: "Other", is_online: true },
          },
        },
      }),
    });
    const result = await controller.registerAsHost({});
    assert.equal(result.ok, false);
    assert.ok(result.conflict);
    assert.equal(cfg.rabbit_host, "");
    assert.equal(cfg.rabbit_password, "");
    assert.equal(cfg.rabbit_version, "");
  });

  it("heartbeat revoke drops creds; promote with rabbit stores and marks consume", async () => {
    let cfg = {
      agent_api_base: "https://api.example.com",
      agent_token: "tok",
      branch_id: "147",
      rabbit_host: "mq.example.com",
      rabbit_password: "secret",
      rabbit_version: "aaaaaaaaaaaaaaaa",
      is_print_host: true,
      host_epoch: 1,
    };
    let phase = "revoke";
    const controller = createStationPrintingController({
      readConfig: () => ({ ...cfg }),
      writeConfig: (patch) => {
        cfg = { ...cfg, ...patch };
      },
      log: () => {},
      request: async (req) => {
        if (!String(req.url).includes("/heartbeat")) {
          return { status: 404, data: {} };
        }
        if (phase === "revoke") {
          return {
            status: 200,
            data: {
              is_print_host: false,
              host_epoch: 2,
              rabbit_version: "aaaaaaaaaaaaaaaa",
            },
          };
        }
        return {
          status: 200,
          data: {
            is_print_host: true,
            host_epoch: 3,
            rabbit_version: "bbbbbbbbbbbbbbbb",
            rabbit: {
              host: "new.mq",
              port: 5672,
              tls: false,
              username: "agent",
              password: "newsecret",
              exchange: "auto_print",
              queue: "printer.Branch.147",
            },
          },
        };
      },
    });
    controller.api.setToken("tok");
    // seed host policy
    controller.policy.applyServerState({ is_print_host: true, host_epoch: 1 });

    const revoked = await controller.heartbeat({ branchId: "147" });
    assert.equal(revoked.ok, true);
    assert.equal(revoked.revoked, true);
    assert.equal(revoked.shouldConsume, false);
    assert.equal(cfg.rabbit_host, "");
    assert.equal(cfg.rabbit_password, "");

    phase = "promote";
    cfg.rabbit_version = ""; // missing → server sends full rabbit
    const promoted = await controller.heartbeat({ branchId: "147" });
    assert.equal(promoted.ok, true);
    assert.equal(promoted.shouldConsume, true);
    assert.equal(cfg.rabbit_host, "new.mq");
    assert.equal(cfg.rabbit_password, "newsecret");
    assert.equal(cfg.rabbit_version, "bbbbbbbbbbbbbbbb");
  });
});
