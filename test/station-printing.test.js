"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { createStationPrintingController } = require("../src/station-printing");

function memoryStore(seed = {}) {
  let cfg = { ...seed };
  return {
    readConfig: () => ({ ...cfg }),
    writeConfig: (partial) => {
      cfg = { ...cfg, ...partial };
    },
    get: () => cfg,
  };
}

describe("station-printing controller", () => {
  it("persists app_id across instances (stable across updates)", () => {
    const store = memoryStore();
    const a = createStationPrintingController(store);
    const b = createStationPrintingController(store);
    assert.equal(a.appId, b.appId);
    assert.match(a.appId, /^[0-9a-f-]{36}$/i);
  });

  it("blocks register when pairing code is blank with inline error", async () => {
    const store = memoryStore({
      agent_api_base: "https://api.example.com",
      branch_id: "147",
    });
    const ctrl = createStationPrintingController({
      ...store,
      request: async () => {
        throw new Error("should not call API");
      },
      log: () => {},
    });
    const res = await ctrl.registerAsHost({ branchId: "147" });
    assert.equal(res.ok, false);
    assert.equal(res.error.code, "PAIRING_CODE_REQUIRED");
    assert.match(res.error.message, /Pairing code is required/i);
    assert.equal(res.pairingError.code, "PAIRING_CODE_REQUIRED");
  });

  it("applies rabbit broker + queue declare options from register", async () => {
    const store = memoryStore({
      agent_api_base: "https://api.example.com",
      branch_id: "147",
      pairing_code: "PAIR",
      device_label: "Desk",
    });
    const request = async () => ({
      status: 200,
      data: {
        token: "tok-r",
        is_print_host: true,
        host_epoch: 2,
        branch_id: 147,
        rabbit: {
          host: "mq.example.com",
          port: 5672,
          username: "print-147",
          password: "secret",
          exchange: "auto_print",
          routing_key: "orders.147",
          queue: "printer.Branch.147",
          queue_durable: true,
          queue_arguments: { "x-single-active-consumer": true },
          consume_exclusive: false,
          prefetch: 1,
        },
      },
      headers: {},
    });
    const ctrl = createStationPrintingController({ ...store, request, log: () => {} });
    const res = await ctrl.registerAsHost({ branchId: "147" });
    assert.equal(res.ok, true);
    assert.equal(store.get().rabbit_host, "mq.example.com");
    assert.equal(store.get().rabbit_password, "secret");
    assert.equal(store.get().rabbit_queue, "printer.Branch.147");
    assert.equal(store.get().rabbit_queue_durable, true);
    assert.equal(
      store.get().rabbit_queue_arguments["x-single-active-consumer"],
      true
    );
    assert.deepEqual(ctrl.rabbitQueueDeclareOptions(), {
      durable: true,
      arguments: { "x-single-active-consumer": true },
    });
    assert.equal(ctrl.rabbitQueueName("147"), "printer.Branch.147");
    assert.deepEqual(ctrl.rabbitConsumeOptions(), { exclusive: false, noAck: false });
  });

  it("surfaces 409 conflict for reinstall / other host", async () => {
    const store = memoryStore({
      agent_api_base: "https://api.example.com",
      branch_id: "147",
      pairing_code: "X",
      device_label: "Desk",
    });
    const request = async () => ({
      status: 409,
      data: {
        error: {
          code: "PRINT_HOST_ALREADY_CONFIGURED",
          message: "Another device is already configured as print host for this branch.",
          current_host: {
            app_id: "other",
            device_label: "Old install",
            is_online: false,
          },
        },
      },
      headers: {},
    });
    const ctrl = createStationPrintingController({ ...store, request, log: () => {} });
    const res = await ctrl.registerAsHost({ branchId: "147" });
    assert.equal(res.ok, false);
    assert.equal(res.shouldConsume, false);
    assert.equal(ctrl.hostConflict.current_host.device_label, "Old install");
  });

  it("ensureSession resumes via heartbeat when token present (no register)", async () => {
    const store = memoryStore({
      agent_api_base: "https://api.example.com",
      agent_token: "tok-existing",
      branch_id: "147",
      is_print_host: true,
      host_epoch: 2,
    });
    let paths = [];
    const request = async (cfg) => {
      paths.push(cfg.url);
      return {
        status: 200,
        data: { is_print_host: true, host_epoch: 2, pending_job_count: 4 },
        headers: {},
      };
    };
    const ctrl = createStationPrintingController({ ...store, request, log: () => {} });
    ctrl.policy.applyServerState({ is_print_host: true, host_epoch: 2 });
    const sess = await ctrl.ensureSession({ branchId: "147" });
    assert.equal(sess.ok, true);
    assert.equal(sess.resumed, true);
    assert.equal(sess.shouldConsume, true);
    assert.ok(paths.every((u) => String(u).includes("/heartbeat")));
    assert.ok(!paths.some((u) => String(u).includes("/register")));
  });

  it("heartbeat 401 clears token and requires fresh pairing", async () => {
    const store = memoryStore({
      agent_api_base: "https://api.example.com",
      agent_token: "tok",
      pairing_code: "OLD",
      branch_id: "147",
      is_print_host: true,
      host_epoch: 2,
    });
    const request = async () => ({
      status: 401,
      data: { error: { code: "UNAUTHORIZED", message: "Token revoked" } },
      headers: {},
    });
    const ctrl = createStationPrintingController({ ...store, request, log: () => {} });
    ctrl.policy.applyServerState({ is_print_host: true, host_epoch: 2 });
    const hb = await ctrl.heartbeat({ branchId: "147" });
    assert.equal(hb.authError, true);
    assert.equal(hb.needsPairing, true);
    assert.equal(ctrl.shouldConsume(), false);
    assert.equal(store.get().agent_token, "");
    assert.equal(store.get().pairing_code, "");
    assert.equal(store.get().is_print_host, false);
    assert.equal(store.get().host_epoch, 1);
    assert.equal(ctrl.needsPairing, true);
  });

  it("deregister clears token, host flags, epoch and requires pairing", async () => {
    const store = memoryStore({
      agent_api_base: "https://api.example.com",
      agent_token: "tok",
      pairing_code: "PAIR",
      branch_id: "147",
      is_print_host: true,
      host_epoch: 7,
    });
    const request = async () => ({ status: 200, data: {}, headers: {} });
    const ctrl = createStationPrintingController({ ...store, request, log: () => {} });
    ctrl.policy.applyServerState({ is_print_host: true, host_epoch: 7 });
    const res = await ctrl.deregister();
    assert.equal(res.needsPairing, true);
    assert.equal(ctrl.shouldConsume(), false);
    assert.equal(store.get().agent_token, "");
    assert.equal(store.get().pairing_code, "");
    assert.equal(store.get().is_print_host, false);
    assert.equal(store.get().host_epoch, 1);
    assert.equal(ctrl.api.getToken(), "");
    // Fresh register needed
    const reg = await ctrl.registerAsHost({ branchId: "147" });
    assert.equal(reg.ok, false);
    assert.equal(reg.error.code, "PAIRING_CODE_REQUIRED");
  });

  it("syncPrintersToServer applies server ids", async () => {
    const store = memoryStore({
      agent_api_base: "https://api.example.com",
      agent_token: "tok",
      branch_id: "147",
    });
    const request = async () => ({
      status: 200,
      data: {
        accepted: 1,
        printers: [{ id: 55, external_id: "Kitchen Printer 1", name: "Kitchen Printer 1" }],
      },
      headers: {},
    });
    const ctrl = createStationPrintingController({ ...store, request, log: () => {} });
    ctrl.syncWindowsPrinters([{ name: "Kitchen Printer 1" }]);
    const res = await ctrl.syncPrintersToServer({ branchId: "147" });
    assert.equal(res.ok, true);
    assert.equal(ctrl.printers.get("Kitchen Printer 1").server_id, 55);
  });

  it("prints when host; delayed=true held jobs parse", () => {
    const store = memoryStore();
    const ctrl = createStationPrintingController({ ...store, log: () => {} });
    ctrl.policy.applyServerState({ is_print_host: true, host_epoch: 1 });
    ctrl.syncWindowsPrinters([{ name: "Kitchen Printer 1" }]);
    const ev = ctrl.evaluateIncomingMessage({
      schema_version: 2,
      job_id: "j1",
      printer_external_id: "Kitchen Printer 1",
      host_epoch: 1,
      pdf_url: "https://cdn.example/a.pdf",
      delayed: true,
    });
    assert.equal(ev.action, "print");
    assert.equal(ev.parsed.delayed, true);
  });

  it("nacks when not host", () => {
    const store = memoryStore();
    const ctrl = createStationPrintingController({ ...store, log: () => {} });
    ctrl.syncWindowsPrinters([{ name: "Kitchen Printer 1" }]);
    const ev = ctrl.evaluateIncomingMessage({
      schema_version: 2,
      job_id: "j1",
      printer_external_id: "Kitchen Printer 1",
      host_epoch: 1,
      pdf_url: "https://cdn.example/a.pdf",
    });
    assert.equal(ev.action, "nack");
  });
});
