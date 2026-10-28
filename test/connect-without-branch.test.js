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



describe("host-only Rabbit credentials (v1.8 final)", () => {
  it("§3 observer register with null version wipes and does not consume", async () => {
    let cfg = {
      agent_api_base: "https://api.example.com",
      pairing_code: "PAIR",
      rabbit_host: "old.mq",
      rabbit_password: "oldsecret",
      rabbit_version: "aaaaaaaaaaaaaaaa",
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
          rabbit_version: null,
        },
      }),
    });
    const result = await controller.registerAsHost({});
    assert.equal(result.ok, true);
    assert.equal(result.shouldConsume, false);
    assert.equal(cfg.rabbit_host, "");
    assert.equal(cfg.rabbit_password, "");
    assert.equal(cfg.rabbit_version, "");
  });

  it("§6 host → null wipes version AND creds together (never keep version)", async () => {
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
    const controller = createStationPrintingController({
      readConfig: () => ({ ...cfg }),
      writeConfig: (patch) => {
        cfg = { ...cfg, ...patch };
      },
      log: () => {},
      request: async (req) => {
        if (!String(req.url).includes("/heartbeat")) return { status: 404, data: {} };
        return {
          status: 200,
          data: { is_print_host: false, host_epoch: 2, rabbit_version: null },
        };
      },
    });
    controller.api.setToken("tok");
    controller.policy.applyServerState({ is_print_host: true, host_epoch: 1 });
    const revoked = await controller.heartbeat({ branchId: "147" });
    assert.equal(revoked.ok, true);
    assert.equal(revoked.shouldConsume, false);
    assert.equal(cfg.rabbit_host, "");
    assert.equal(cfg.rabbit_password, "");
    assert.equal(cfg.rabbit_version, "");
    // Never wipe creds but keep version:
    assert.ok(!(cfg.rabbit_host === "" && cfg.rabbit_version === "aaaaaaaaaaaaaaaa"));
  });

  it("§6 is_print_host false alone wipes even if version key missing", async () => {
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
    const controller = createStationPrintingController({
      readConfig: () => ({ ...cfg }),
      writeConfig: (patch) => {
        cfg = { ...cfg, ...patch };
      },
      log: () => {},
      request: async (req) => {
        if (!String(req.url).includes("/heartbeat")) return { status: 404, data: {} };
        return { status: 200, data: { is_print_host: false, host_epoch: 2 } };
      },
    });
    controller.api.setToken("tok");
    controller.policy.applyServerState({ is_print_host: true, host_epoch: 1 });
    await controller.heartbeat({ branchId: "147" });
    assert.equal(cfg.rabbit_host, "");
    assert.equal(cfg.rabbit_version, "");
  });

  it("§7 null → full rabbit stores and consumes", async () => {
    let cfg = {
      agent_api_base: "https://api.example.com",
      agent_token: "tok",
      branch_id: "147",
      rabbit_host: "",
      rabbit_password: "",
      rabbit_version: "",
      is_print_host: false,
      host_epoch: 1,
    };
    const controller = createStationPrintingController({
      readConfig: () => ({ ...cfg }),
      writeConfig: (patch) => {
        cfg = { ...cfg, ...patch };
      },
      log: () => {},
      request: async (req) => {
        if (!String(req.url).includes("/heartbeat")) return { status: 404, data: {} };
        return {
          status: 200,
          data: {
            is_print_host: true,
            host_epoch: 3,
            rabbit_version: "bbbbbbbbbbbbbbbb",
            rabbit: {
              host: "new.mq",
              port: 5672,
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
    controller.policy.applyServerState({ is_print_host: false, host_epoch: 1 });
    const promoted = await controller.heartbeat({ branchId: "147" });
    assert.equal(promoted.shouldConsume, true);
    assert.equal(cfg.rabbit_host, "new.mq");
    assert.equal(cfg.rabbit_password, "newsecret");
    assert.equal(cfg.rabbit_version, "bbbbbbbbbbbbbbbb");
  });

  it("§4 heartbeat omits rabbit_version when not host or no creds", async () => {
    let cfg = {
      agent_api_base: "https://api.example.com",
      agent_token: "tok",
      branch_id: "147",
      rabbit_host: "",
      rabbit_password: "",
      rabbit_version: "aaaaaaaaaaaaaaaa",
      is_print_host: true,
      host_epoch: 2,
    };
    const bodies = [];
    const controller = createStationPrintingController({
      readConfig: () => ({ ...cfg }),
      writeConfig: (patch) => {
        cfg = { ...cfg, ...patch };
      },
      log: () => {},
      request: async (req) => {
        bodies.push(req.data);
        return {
          status: 200,
          data: { is_print_host: true, host_epoch: 2, pending_job_count: 0 },
        };
      },
    });
    controller.api.setToken("tok");
    controller.policy.applyServerState({ is_print_host: true, host_epoch: 2 });
    await controller.heartbeat({ branchId: "147" });
    assert.equal(bodies[0].rabbit_version, undefined);

    // With creds + host → send
    cfg.rabbit_host = "mq.example.com";
    cfg.rabbit_password = "secret";
    bodies.length = 0;
    await controller.heartbeat({ branchId: "147" });
    assert.equal(bodies[0].rabbit_version, "aaaaaaaaaaaaaaaa");

    // Not host → omit even with leftover version (should already be wiped, but §4)
    cfg.is_print_host = false;
    bodies.length = 0;
    // After non-host response wipe happens; seed version again to prove omit on request
    cfg.rabbit_version = "aaaaaaaaaaaaaaaa";
    cfg.rabbit_host = "mq.example.com";
    controller.policy.applyServerState({ is_print_host: false, host_epoch: 3 });
    // Force cfg flag for request builder before response wipe:
    await controller.heartbeat({ branchId: "147" });
    assert.equal(bodies[0].rabbit_version, undefined);
  });

  it("§5 rabbit present always replaces config even if versions match", async () => {
    let cfg = {
      agent_api_base: "https://api.example.com",
      agent_token: "tok",
      branch_id: "147",
      rabbit_host: "old.mq",
      rabbit_password: "oldsecret",
      rabbit_version: "aaaaaaaaaaaaaaaa",
      is_print_host: true,
      host_epoch: 2,
    };
    const controller = createStationPrintingController({
      readConfig: () => ({ ...cfg }),
      writeConfig: (patch) => {
        cfg = { ...cfg, ...patch };
      },
      log: () => {},
      request: async (req) => {
        if (!String(req.url).includes("/heartbeat")) return { status: 404, data: {} };
        return {
          status: 200,
          data: {
            is_print_host: true,
            host_epoch: 2,
            rabbit_version: "aaaaaaaaaaaaaaaa",
            rabbit: {
              host: "rotated.mq",
              port: 5672,
              username: "agent",
              password: "rotated",
              queue: "printer.Branch.147",
            },
          },
        };
      },
    });
    controller.api.setToken("tok");
    controller.policy.applyServerState({ is_print_host: true, host_epoch: 2 });
    const live = await controller.heartbeat({ branchId: "147" });
    assert.equal(cfg.rabbit_host, "rotated.mq");
    assert.equal(cfg.rabbit_password, "rotated");
    assert.equal(live.rabbitChanged, true);
  });

  it("§6 401 clears version and creds together", async () => {
    let cfg = {
      agent_api_base: "https://api.example.com",
      agent_token: "tok",
      branch_id: "147",
      rabbit_host: "mq.example.com",
      rabbit_password: "secret",
      rabbit_version: "aaaaaaaaaaaaaaaa",
      is_print_host: true,
      host_epoch: 2,
      pairing_code: "OLD",
    };
    const controller = createStationPrintingController({
      readConfig: () => ({ ...cfg }),
      writeConfig: (patch) => {
        cfg = { ...cfg, ...patch };
      },
      log: () => {},
      request: async () => ({
        status: 401,
        data: { error: { code: "UNAUTHORIZED", message: "Token revoked" } },
      }),
    });
    controller.api.setToken("tok");
    await controller.heartbeat({ branchId: "147" });
    assert.equal(cfg.agent_token, "");
    assert.equal(cfg.rabbit_host, "");
    assert.equal(cfg.rabbit_password, "");
    assert.equal(cfg.rabbit_version, "");
  });

  it("host with matching version key keep (older-style omit rabbit) keeps creds", async () => {
    let cfg = {
      agent_api_base: "https://api.example.com",
      agent_token: "tok",
      branch_id: "147",
      rabbit_host: "mq.example.com",
      rabbit_password: "secret",
      rabbit_version: "aaaaaaaaaaaaaaaa",
      is_print_host: true,
      host_epoch: 2,
    };
    const controller = createStationPrintingController({
      readConfig: () => ({ ...cfg }),
      writeConfig: (patch) => {
        cfg = { ...cfg, ...patch };
      },
      log: () => {},
      request: async (req) => {
        if (!String(req.url).includes("/heartbeat")) return { status: 404, data: {} };
        return {
          status: 200,
          data: {
            is_print_host: true,
            host_epoch: 2,
            rabbit_version: "aaaaaaaaaaaaaaaa",
          },
        };
      },
    });
    controller.api.setToken("tok");
    controller.policy.applyServerState({ is_print_host: true, host_epoch: 2 });
    const live = await controller.heartbeat({ branchId: "147" });
    assert.equal(live.shouldConsume, true);
    assert.equal(cfg.rabbit_host, "mq.example.com");
    assert.equal(cfg.rabbit_version, "aaaaaaaaaaaaaaaa");
  });
});
