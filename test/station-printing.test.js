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
      // Host-only: consumer needs stored broker creds (HB may omit rabbit when version matches).
      rabbit_host: "mq.example.com",
      rabbit_password: "secret",
      rabbit_version: "aaaaaaaaaaaaaaaa",
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
        printers: [{ id: 55, external_id: "win:Kitchen Printer 1", name: "Kitchen Printer 1" }],
      },
      headers: {},
    });
    const ctrl = createStationPrintingController({ ...store, request, log: () => {} });
    ctrl.syncWindowsPrinters([{ name: "Kitchen Printer 1" }]);
    const res = await ctrl.syncPrintersToServer({ branchId: "147" });
    assert.equal(res.ok, true);
    assert.equal(ctrl.printers.get("win:Kitchen Printer 1").server_id, 55);
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

  it("syncPrintersToServer retries SYNC_CONFLICT then succeeds", async () => {
    const store = memoryStore({
      agent_api_base: "https://api.example.com",
      agent_token: "tok",
      branch_id: "147",
    });
    let calls = 0;
    const sleeps = [];
    const request = async () => {
      calls += 1;
      if (calls < 3) {
        return {
          status: 409,
          data: { error: { code: "SYNC_CONFLICT", message: "lock wait" } },
          headers: {},
        };
      }
      return {
        status: 200,
        data: {
          accepted: 1,
          printers: [{ id: 77, external_id: "win:Kitchen Printer 1", name: "Kitchen Printer 1" }],
        },
        headers: {},
      };
    };
    const ctrl = createStationPrintingController({
      ...store,
      request,
      log: () => {},
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    ctrl.syncWindowsPrinters([{ name: "Kitchen Printer 1" }]);
    const res = await ctrl.syncPrintersToServer({ branchId: "147" });
    assert.equal(res.ok, true);
    assert.equal(calls, 3);
    assert.equal(sleeps.length, 2);
    assert.ok(sleeps[0] >= 200 && sleeps[0] < 500);
    assert.equal(ctrl.printers.get("win:Kitchen Printer 1").server_id, 77);
  });

  it("syncPrintersToServer exhausts SYNC_CONFLICT then falls back (no host conflict)", async () => {
    const store = memoryStore({
      agent_api_base: "https://api.example.com",
      agent_token: "tok",
      branch_id: "147",
    });
    let calls = 0;
    const request = async () => {
      calls += 1;
      return {
        status: 409,
        data: { error: { code: "SYNC_CONFLICT", message: "still locked" } },
        headers: {},
      };
    };
    const ctrl = createStationPrintingController({
      ...store,
      request,
      log: () => {},
      sleep: async () => {},
    });
    ctrl.syncWindowsPrinters([{ name: "Kitchen Printer 1" }]);
    const res = await ctrl.syncPrintersToServer({ branchId: "147" });
    assert.equal(res.ok, false);
    assert.equal(res.syncConflict, true);
    assert.equal(res.retriesExhausted, true);
    assert.equal(res.code, "SYNC_CONFLICT");
    assert.equal(calls, 3);
    // Must not be treated as PRINT_HOST_ALREADY_CONFIGURED
    assert.equal(ctrl.hostConflict, null);
  });

  it("register 409 PRINT_HOST_ALREADY_CONFIGURED is not confused with SYNC_CONFLICT", async () => {
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
          message: "taken",
          current_host: { app_id: "other", device_label: "Old", is_online: false },
        },
      },
      headers: {},
    });
    const ctrl = createStationPrintingController({ ...store, request, log: () => {} });
    const res = await ctrl.registerAsHost({ branchId: "147" });
    assert.equal(res.ok, false);
    assert.equal(ctrl.hostConflict.code, "PRINT_HOST_ALREADY_CONFIGURED");
  });

  it("heartbeat is liveness-only — no printer-list upsert on the 30s cadence", async () => {
    const store = memoryStore({
      agent_api_base: "https://api.example.com",
      agent_token: "tok",
      branch_id: "147",
      is_print_host: true,
      host_epoch: 2,
    });
    let liveCalls = 0;
    let upsertCalls = 0;
    const request = async (cfg) => {
      const url = String(cfg.url || "");
      const body = cfg.data || {};
      if (url.includes("/heartbeat")) {
        const list = Array.isArray(body.printers) ? body.printers : [];
        if (list.length === 0) {
          liveCalls += 1;
          return {
            status: 200,
            data: { is_print_host: true, host_epoch: 2, pending_job_count: 1 },
            headers: {},
          };
        }
        upsertCalls += 1;
        return {
          status: 200,
          data: { is_print_host: true, host_epoch: 2, pending_job_count: 1 },
          headers: {},
        };
      }
      return { status: 200, data: {}, headers: {} };
    };
    const ctrl = createStationPrintingController({
      ...store,
      request,
      log: () => {},
      sleep: async () => {},
    });
    ctrl.policy.applyServerState({ is_print_host: true, host_epoch: 2 });
    ctrl.syncWindowsPrinters([{ name: "Kitchen Printer 1" }]);
    const res = await ctrl.heartbeat({ branchId: "147" });
    assert.equal(res.ok, true);
    assert.equal(liveCalls, 1);
    assert.equal(upsertCalls, 0);
    assert.equal(res.printerUpsert, null);
    assert.equal(res.syncConflict, false);
  });

  it("heartbeat continues while printer-list config is unchanged (hash skip on sync)", async () => {
    const store = memoryStore({
      agent_api_base: "https://api.example.com",
      agent_token: "tok",
      branch_id: "147",
      is_print_host: true,
      host_epoch: 1,
    });
    let liveCalls = 0;
    let syncCalls = 0;
    const request = async (cfg) => {
      const url = String(cfg.url || "");
      if (url.includes("/heartbeat")) {
        liveCalls += 1;
        return {
          status: 200,
          data: { is_print_host: true, host_epoch: 1, pending_job_count: 0 },
          headers: {},
        };
      }
      if (url.includes("/printers/sync")) {
        syncCalls += 1;
        return {
          status: 200,
          data: { accepted: 1, printers: [{ id: 9, external_id: "win:Kitchen Printer 1" }] },
          headers: {},
        };
      }
      return { status: 200, data: {}, headers: {} };
    };
    const ctrl = createStationPrintingController({
      ...store,
      request,
      log: () => {},
      sleep: async () => {},
    });
    ctrl.syncWindowsPrinters([{ name: "Kitchen Printer 1" }]);
    const first = await ctrl.syncPrintersToServer({ branchId: "147" });
    assert.equal(first.ok, true);
    assert.equal(syncCalls, 1);
    const second = await ctrl.syncPrintersToServer({ branchId: "147" });
    assert.equal(second.ok, true);
    assert.equal(second.unchanged, true);
    assert.equal(syncCalls, 1, "unchanged hash must skip HTTP");
    const hb1 = await ctrl.heartbeat({ branchId: "147" });
    const hb2 = await ctrl.heartbeat({ branchId: "147" });
    assert.equal(hb1.ok, true);
    assert.equal(hb2.ok, true);
    assert.equal(liveCalls, 2);
    assert.equal(syncCalls, 1, "heartbeat must not trigger printers/sync");
  });

  it("single-flight: sync and heartbeat printer upsert never overlap", async () => {
    const store = memoryStore({
      agent_api_base: "https://api.example.com",
      agent_token: "tok",
      branch_id: "147",
    });
    let upsertInFlight = 0;
    let maxUpsertInFlight = 0;
    const events = [];
    const request = async (cfg) => {
      const url = String(cfg.url || "");
      const body = cfg.data || {};
      const printers = Array.isArray(body.printers) ? body.printers : [];
      const isLive =
        url.includes("/heartbeat") && printers.length === 0;
      const isUpsert =
        url.includes("/printers/sync") ||
        (url.includes("/heartbeat") && printers.length > 0);
      const kind = isLive
        ? "live"
        : url.includes("/printers/sync")
          ? "sync"
          : url.includes("/heartbeat")
            ? "hb-upsert"
            : "other";
      if (isUpsert) {
        upsertInFlight += 1;
        maxUpsertInFlight = Math.max(maxUpsertInFlight, upsertInFlight);
      }
      events.push("start:" + kind);
      await new Promise((r) => setTimeout(r, 30));
      if (isUpsert) upsertInFlight -= 1;
      events.push("end:" + kind);
      if (url.includes("/heartbeat")) {
        return {
          status: 200,
          data: { is_print_host: true, host_epoch: 1, pending_job_count: 0 },
          headers: {},
        };
      }
      return {
        status: 200,
        data: {
          accepted: 1,
          printers: [
            {
              id: 1,
              external_id: "win:Kitchen Printer 1",
              name: "Kitchen Printer 1",
            },
          ],
        },
        headers: {},
      };
    };
    const ctrl = createStationPrintingController({
      ...store,
      request,
      log: () => {},
      sleep: async () => {},
    });
    ctrl.syncWindowsPrinters([{ name: "Kitchen Printer 1" }]);
    const hbP = ctrl.heartbeat({ branchId: "147" });
    const syncP = ctrl.syncPrintersToServer({ branchId: "147" });
    const [hb, sync] = await Promise.all([hbP, syncP]);
    assert.equal(hb.ok, true);
    assert.equal(sync.ok, true);
    assert.equal(
      maxUpsertInFlight,
      1,
      "expected single-flight upserts, saw " +
        maxUpsertInFlight +
        " overlapping; events=" +
        events.join(",")
    );
    assert.ok(ctrl.isPrinterSyncInFlight() === false);
  });

  it("liveness heartbeat goes out while sync retries hold the gate", async () => {
    const store = memoryStore({
      agent_api_base: "https://api.example.com",
      agent_token: "tok",
      branch_id: "147",
    });
    let syncAttempts = 0;
    let liveAt = null;
    let syncFirstStart = null;
    const request = async (cfg) => {
      const url = String(cfg.url || "");
      const body = cfg.data || {};
      if (url.includes("/printers/sync")) {
        syncAttempts += 1;
        if (syncFirstStart == null) syncFirstStart = Date.now();
        // Hold the gate long enough that a gated HB would starve liveness.
        await new Promise((r) => setTimeout(r, 80));
        if (syncAttempts < 3) {
          return {
            status: 409,
            data: { error: { code: "SYNC_CONFLICT", message: "busy" } },
            headers: {},
          };
        }
        return {
          status: 200,
          data: {
            accepted: 1,
            printers: [
              {
                id: 1,
                external_id: "win:Kitchen Printer 1",
                name: "Kitchen Printer 1",
              },
            ],
          },
          headers: {},
        };
      }
      if (url.includes("/heartbeat")) {
        const list = Array.isArray(body.printers) ? body.printers : [];
        if (list.length === 0) {
          liveAt = Date.now();
          return {
            status: 200,
            data: { is_print_host: true, host_epoch: 1, pending_job_count: 0 },
            headers: {},
          };
        }
        return {
          status: 200,
          data: { is_print_host: true, host_epoch: 1, pending_job_count: 0 },
          headers: {},
        };
      }
      return { status: 200, data: {}, headers: {} };
    };
    const ctrl = createStationPrintingController({
      ...store,
      request,
      log: () => {},
      sleep: async () => {},
    });
    ctrl.syncWindowsPrinters([{ name: "Kitchen Printer 1" }]);
    const syncP = ctrl.syncPrintersToServer({ branchId: "147" });
    // Let sync grab the gate
    await new Promise((r) => setTimeout(r, 20));
    const hbStarted = Date.now();
    const hbP = ctrl.heartbeat({ branchId: "147" });
    // Poll until ungated liveness fires (must not wait for sync retries to finish)
    for (let i = 0; i < 40 && liveAt == null; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(liveAt != null, "liveness ping must reach the network while sync holds the gate");
    assert.ok(
      liveAt - hbStarted < 150,
      "liveness must not wait on sync gate; delta=" + (liveAt - hbStarted)
    );
    assert.ok(
      syncAttempts >= 1 && syncAttempts < 3,
      "sync should still be retrying when liveness fired; attempts=" + syncAttempts
    );
    const [hb, sync] = await Promise.all([hbP, syncP]);
    assert.equal(hb.ok, true);
    assert.equal(sync.ok, true);
    assert.equal(syncAttempts, 3);
  });

  it("skips overlapping ungated liveness — second tick while ping in flight", async () => {
    const store = memoryStore({
      agent_api_base: "https://api.example.com",
      agent_token: "tok",
      branch_id: "147",
    });
    let liveInFlight = 0;
    let maxLive = 0;
    let liveCalls = 0;
    let release;
    const hold = new Promise((r) => {
      release = r;
    });
    const ctrl = createStationPrintingController({
      ...store,
      log: () => {},
      sleep: async () => {},
      request: async (cfg) => {
        const body = cfg.data || {};
        const list = Array.isArray(body.printers) ? body.printers : [];
        if (String(cfg.url || "").includes("/heartbeat") && list.length === 0) {
          liveCalls += 1;
          liveInFlight += 1;
          maxLive = Math.max(maxLive, liveInFlight);
          await hold;
          liveInFlight -= 1;
          return {
            status: 200,
            data: { is_print_host: true, host_epoch: 1, pending_job_count: 0 },
            headers: {},
          };
        }
        return {
          status: 200,
          data: { is_print_host: true, host_epoch: 1, pending_job_count: 0 },
          headers: {},
        };
      },
    });
    const a = ctrl.heartbeat({ branchId: "147" });
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(ctrl.isLivenessInFlight(), true);
    const b = await ctrl.heartbeat({ branchId: "147" });
    assert.equal(b.livenessSkipped, true);
    assert.equal(b.skipped, true);
    assert.equal(b.ok, true);
    release();
    const aRes = await a;
    assert.equal(aRes.ok, true);
    assert.equal(liveCalls, 1, "second tick must not send another printers:[]");
    assert.equal(maxLive, 1);
    assert.equal(ctrl.isLivenessInFlight(), false);
  });

  it("status fingerprint change is pushed immediately via printers/status", async () => {
    const store = memoryStore({
      agent_api_base: "https://api.example.com",
      agent_token: "tok",
      branch_id: "147",
    });
    let statusCalls = 0;
    const request = async (cfg) => {
      const url = String(cfg.url || "");
      if (url.includes("/printers/") && url.includes("/status")) {
        statusCalls += 1;
        return { status: 200, data: { ok: true }, headers: {} };
      }
      return { status: 200, data: {}, headers: {} };
    };
    const ctrl = createStationPrintingController({
      ...store,
      request,
      log: () => {},
      sleep: async () => {},
    });
    ctrl.syncWindowsPrinters([{ name: "Kitchen Printer 1" }]);
    // Force a status change on the registry row
    const list = ctrl.printers.list();
    assert.ok(list.length >= 1);
    const eid = list[0].external_id;
    ctrl.printers.upsert({
      ...list[0],
      external_id: eid,
      status: "error",
      status_detail: "Out of paper",
    });
    const first = await ctrl.pushPrinterStatusesIfChanged();
    assert.equal(first.ok, true);
    assert.ok(statusCalls >= 1);
    const second = await ctrl.pushPrinterStatusesIfChanged();
    assert.equal(second.unchanged, true);
    assert.equal(statusCalls, statusCalls); // no extra calls
    const after = statusCalls;
    await ctrl.pushPrinterStatusesIfChanged();
    assert.equal(statusCalls, after, "unchanged status must not re-POST");
  });

  it("failed status push retries then commits fingerprint; no resend after success", async () => {
    const store = memoryStore({
      agent_api_base: "https://api.example.com",
      agent_token: "tok",
      branch_id: "147",
    });
    let statusCalls = 0;
    let failLeft = 2;
    const timers = [];
    const ctrl = createStationPrintingController({
      ...store,
      log: () => {},
      sleep: async () => {},
      setTimeout: (fn) => {
        timers.push(fn);
        return 1;
      },
      clearTimeout: () => {},
      request: async (cfg) => {
        const url = String(cfg.url || "");
        if (url.includes("/printers/") && url.includes("/status")) {
          statusCalls += 1;
          if (failLeft > 0) {
            failLeft -= 1;
            return {
              status: 500,
              data: { error: { code: "SERVER", message: "boom" } },
              headers: {},
            };
          }
          return { status: 200, data: { ok: true }, headers: {} };
        }
        return { status: 200, data: {}, headers: {} };
      },
    });
    ctrl.syncWindowsPrinters([{ name: "Kitchen Printer 1" }]);
    const list = ctrl.printers.list();
    const eid = list[0].external_id;
    ctrl.printers.upsert({
      ...list[0],
      external_id: eid,
      status: "error",
      status_detail: "Out of paper",
    });
    const first = await ctrl.pushPrinterStatusesIfChanged();
    assert.equal(first.ok, false);
    assert.equal(first.committed, false);
    assert.ok(statusCalls >= 1);
    // Fingerprint must NOT be stored — second call retries
    const second = await ctrl.pushPrinterStatusesIfChanged();
    assert.equal(second.ok, false);
    assert.ok(statusCalls >= 2);
    const third = await ctrl.pushPrinterStatusesIfChanged();
    assert.equal(third.ok, true);
    assert.equal(third.committed, true);
    const after = statusCalls;
    const fourth = await ctrl.pushPrinterStatusesIfChanged();
    assert.equal(fourth.unchanged, true);
    assert.equal(statusCalls, after, "no resend after successful commit");
  });

  it("persistent 5xx status push does not flood logs", async () => {
    const store = memoryStore({
      agent_api_base: "https://api.example.com",
      agent_token: "tok",
      branch_id: "147",
    });
    const logs = [];
    let statusCalls = 0;
    const ctrl = createStationPrintingController({
      ...store,
      log: (msg) => logs.push(String(msg)),
      sleep: async () => {},
      setTimeout: () => 1,
      clearTimeout: () => {},
      request: async (cfg) => {
        const url = String(cfg.url || "");
        if (url.includes("/status")) {
          statusCalls += 1;
          return {
            status: 500,
            data: { error: { code: "SERVER", message: "boom" } },
            headers: {},
          };
        }
        return { status: 200, data: {}, headers: {} };
      },
    });
    ctrl.syncWindowsPrinters([{ name: "Kitchen Printer 1" }]);
    const list = ctrl.printers.list();
    ctrl.printers.upsert({
      ...list[0],
      external_id: list[0].external_id,
      status: "offline",
    });
    for (let i = 0; i < 9; i++) {
      await ctrl.pushPrinterStatusesIfChanged();
    }
    assert.ok(statusCalls >= 9);
    const failLogs = logs.filter((m) => m.includes("Printer status push failed"));
    // Throttled: 1st, 3rd, 6th, 9th... << 9
    assert.ok(failLogs.length < statusCalls, `logs=${failLogs.length} calls=${statusCalls}`);
    assert.ok(failLogs.length <= 4, `expected <=4 throttled logs, got ${failLogs.length}`);
    assert.equal(
      (store.readConfig().last_printer_status_fingerprint || ""),
      "",
      "fingerprint must stay unset while failing"
    );
  });

  it("failed heartbeat recovers without flooding logs", async () => {
    const store = memoryStore({
      agent_api_base: "https://api.example.com",
      agent_token: "tok",
      branch_id: "147",
    });
    const logs = [];
    let n = 0;
    const ctrl = createStationPrintingController({
      ...store,
      log: (msg) => logs.push(String(msg)),
      sleep: async () => {},
      request: async () => {
        n += 1;
        if (n <= 2) {
          return {
            status: 500,
            data: { error: { code: "SERVER", message: "boom" } },
            headers: {},
          };
        }
        return {
          status: 200,
          data: { is_print_host: true, host_epoch: 1, pending_job_count: 0 },
          headers: {},
        };
      },
    });
    const r1 = await ctrl.heartbeat({ branchId: "147" });
    const r2 = await ctrl.heartbeat({ branchId: "147" });
    const r3 = await ctrl.heartbeat({ branchId: "147" });
    assert.equal(r1.ok, false);
    assert.equal(r2.ok, false);
    assert.equal(r3.ok, true);
    const failLogs = logs.filter((m) => /Heartbeat liveness failed/i.test(m));
    assert.equal(failLogs.length, 1, "second failure must be throttled");
    assert.ok(logs.some((m) => /Heartbeat recovered/i.test(m)));
  });

});


describe("station printing rabbit manual override", () => {
  it("register with override on keeps local broker host", async () => {
    const store = memoryStore({
      agent_api_base: "https://api.example.com",
      branch_id: "147",
      pairing_code: "PAIR",
      device_label: "Desk",
      rabbit_host: "manual.local",
      rabbit_port: 5673,
      rabbit_username: "manual",
      rabbit_password: "manualpw",
      rabbit_exchange: "manual_ex",
      rabbit_routing_key: "manual.key",
      rabbit_manual_override: true,
    });
    const request = async () => ({
      status: 200,
      data: {
        token: "tok",
        is_print_host: true,
        host_epoch: 2,
        branch_id: 147,
        rabbit: {
          host: "mq.example.com",
          port: 5672,
          username: "agent",
          password: "secret",
          exchange: "auto_print",
          routing_key: "orders.147",
          queue: "printer.Branch.147",
          queue_durable: true,
          queue_arguments: { "x-single-active-consumer": true },
          prefetch: 1,
          vhost: "/",
        },
      },
      headers: {},
    });
    const ctrl = createStationPrintingController({ ...store, request, log: () => {} });
    const res = await ctrl.registerAsHost({ branchId: "147" });
    assert.equal(res.ok, true);
    assert.equal(store.get().rabbit_host, "manual.local");
    assert.equal(store.get().rabbit_password, "manualpw");
    assert.equal(store.get().rabbit_queue, "printer.Branch.147");
    assert.equal(store.get().branch_id, "147");
  });
});
