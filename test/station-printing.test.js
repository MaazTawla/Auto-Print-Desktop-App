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
  it("persists app_id across instances", () => {
    const store = memoryStore();
    const a = createStationPrintingController(store);
    const b = createStationPrintingController(store);
    assert.equal(a.appId, b.appId);
    assert.match(a.appId, /^[0-9a-f-]{36}$/i);
  });

  it("rejects register without pairing_code", async () => {
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
    assert.equal(res.error.code, "VALIDATION_ERROR");
  });

  it("surfaces 409 conflict and disables consume", async () => {
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
            device_label: "Front counter tablet - POS app",
            is_online: true,
          },
        },
      },
      headers: {},
    });
    const ctrl = createStationPrintingController({ ...store, request, log: () => {} });
    const res = await ctrl.registerAsHost({ branchId: "147" });
    assert.equal(res.ok, false);
    assert.equal(res.shouldConsume, false);
    assert.equal(ctrl.shouldConsume(), false);
    assert.equal(
      ctrl.hostConflict.message,
      "Another device is already configured as print host for this branch."
    );
    assert.equal(ctrl.hostConflict.current_host.device_label, "Front counter tablet - POS app");
  });

  it("promotes on register and sets flushPending; uses flat token", async () => {
    const store = memoryStore({
      agent_api_base: "https://api.example.com",
      branch_id: "147",
      pairing_code: "PAIR-1",
      device_label: "Desk PC",
    });
    let captured;
    const request = async (cfg) => {
      captured = cfg;
      return {
        status: 200,
        data: {
          token: "tok-1",
          is_print_host: true,
          host_epoch: 2,
          heartbeat_interval_seconds: 30,
          heartbeat_ttl_seconds: 90,
        },
        headers: {},
      };
    };
    const ctrl = createStationPrintingController({ ...store, request, log: () => {} });
    const res = await ctrl.registerAsHost({ branchId: "147" });
    assert.equal(res.ok, true);
    assert.equal(res.shouldConsume, true);
    assert.equal(res.promoted, true);
    assert.equal(ctrl.flushPending, true);
    assert.equal(store.get().agent_token, "tok-1");
    assert.equal(captured.headers.Authorization, undefined);
    assert.equal(JSON.parse(JSON.stringify(captured.data)).pairing_code, "PAIR-1");
    assert.equal(captured.data.role, "print_host");
  });

  it("heartbeat epoch revoke stops consume", async () => {
    const store = memoryStore({
      agent_api_base: "https://api.example.com",
      agent_token: "tok",
      branch_id: "147",
      is_print_host: true,
      host_epoch: 1,
    });
    let calls = 0;
    const request = async () => {
      calls += 1;
      return {
        status: 200,
        data: { is_print_host: false, host_epoch: 9, pending_job_count: 3 },
        headers: {},
      };
    };
    const ctrl = createStationPrintingController({ ...store, request, log: () => {} });
    ctrl.policy.applyServerState({ is_print_host: true, host_epoch: 1 });
    const hb = await ctrl.heartbeat({ branchId: "147" });
    assert.equal(calls, 1);
    assert.equal(hb.revoked, true);
    assert.equal(ctrl.shouldConsume(), false);
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
        printers: [
          { id: 55, external_id: "Kitchen Printer 1", name: "Kitchen Printer 1" },
        ],
      },
      headers: {},
    });
    const ctrl = createStationPrintingController({ ...store, request, log: () => {} });
    ctrl.syncWindowsPrinters([{ name: "Kitchen Printer 1" }]);
    const res = await ctrl.syncPrintersToServer({ branchId: "147" });
    assert.equal(res.ok, true);
    assert.equal(ctrl.printers.get("Kitchen Printer 1").server_id, 55);
  });

  it("routes and nacks when not host", () => {
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
    assert.equal(ev.reason, "not_print_host");
  });

  it("prints when host and printer known (pdf_url)", () => {
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
      station_name: "Kitchen",
    });
    assert.equal(ev.action, "print");
    assert.equal(ev.route.printer.windows_name, "Kitchen Printer 1");
    assert.equal(ev.parsed.delayed, true);
    assert.equal(ev.parsed.pdf_url, "https://cdn.example/a.pdf");
  });

  it("rabbitConsumeArgs requests SAC; consume options exclusive=false", () => {
    const ctrl = createStationPrintingController({
      readConfig: () => ({}),
      writeConfig: () => {},
      log: () => {},
    });
    assert.deepEqual(ctrl.rabbitConsumeArgs(), { "x-single-active-consumer": true });
    assert.deepEqual(ctrl.rabbitConsumeOptions(), { exclusive: false, noAck: false });
  });
});
