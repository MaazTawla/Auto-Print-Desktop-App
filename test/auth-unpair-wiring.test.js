"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { createStationPrintingController } = require("../src/station-printing");

function memoryStore(seed = {}) {
  let cfg = { ...seed };
  return {
    readConfig: () => ({ ...cfg }),
    writeConfig: (patch) => {
      cfg = { ...cfg, ...patch };
    },
  };
}

describe("auth unpair wiring (L3-R2)", () => {
  it("clean heartbeat resets soft-auth after soft 403s (even with consecutiveHbFailures=0)", async () => {
    const store = memoryStore({
      agent_api_base: "https://api.example.com",
      agent_token: "tok",
      branch_id: "147",
      is_print_host: true,
      host_epoch: 1,
    });
    let n = 0;
    const ctrl = createStationPrintingController({
      ...store,
      log: () => {},
      sleep: async () => {},
      request: async (cfg) => {
        const url = String(cfg.url || "");
        if (url.includes("/heartbeat")) {
          n += 1;
          // First two HB: soft 403 FORBIDDEN; then success
          if (n <= 2) {
            return {
              status: 403,
              data: { error: { code: "FORBIDDEN", message: "nope" } },
              headers: {},
            };
          }
          return {
            status: 200,
            data: {
              is_print_host: true,
              host_epoch: 1,
              pending_job_count: 0,
            },
            headers: {},
          };
        }
        return { status: 200, data: {}, headers: {} };
      },
    });

    const a = await ctrl.heartbeat({});
    assert.equal(a.ok, false);
    const b = await ctrl.heartbeat({});
    assert.equal(b.ok, false);
    // Soft ×2 — still paired
    assert.equal(Boolean(store.readConfig().agent_token), true);

    const c = await ctrl.heartbeat({});
    assert.equal(c.ok, true);
    // Clean success must reset; another soft 403 must NOT unpair
    await ctrl.heartbeat({}); // another success keeps counter at 0
    assert.equal(Boolean(store.readConfig().agent_token), true);

    // Drive soft 403 via handleAuthFailure (status path)
    assert.equal(
      ctrl.handleAuthFailure(
        { ok: false, status: 403, code: "FORBIDDEN", error: { code: "FORBIDDEN" } },
        "t"
      ),
      false
    );
    assert.equal(
      ctrl.handleAuthFailure(
        { ok: false, status: 403, code: "FORBIDDEN", error: { code: "FORBIDDEN" } },
        "t"
      ),
      false
    );
    // Third soft would unpair — unless clean HB reset the counter above.
    // We had 2 soft HBs then success (reset) then 2 soft handleAuthFailure → still 2.
    assert.equal(Boolean(store.readConfig().agent_token), true);
    const third = ctrl.handleAuthFailure(
      { ok: false, status: 403, code: "FORBIDDEN", error: { code: "FORBIDDEN" } },
      "t"
    );
    assert.equal(third, true);
    assert.equal(store.readConfig().agent_token, "");
  });

  it("status push 401 clears session; soft 403 ×3 clears", async () => {
    const store = memoryStore({
      agent_api_base: "https://api.example.com",
      agent_token: "tok",
      branch_id: "147",
      is_print_host: true,
      host_epoch: 1,
    });
    let statusMode = "403";
    const ctrl = createStationPrintingController({
      ...store,
      log: () => {},
      sleep: async () => {},
      setTimeout: () => 1,
      clearTimeout: () => {},
      request: async (cfg) => {
        const url = String(cfg.url || "");
        if (url.includes("/status")) {
          if (statusMode === "401") {
            return {
              status: 401,
              data: { error: { code: "UNAUTHORIZED", message: "revoked" } },
              headers: {},
            };
          }
          return {
            status: 403,
            data: { error: { code: "FORBIDDEN", message: "nope" } },
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

    // Soft 403 ×2 keep session
    await ctrl.pushPrinterStatusesIfChanged();
    await ctrl.pushPrinterStatusesIfChanged();
    assert.equal(store.readConfig().agent_token, "tok");

    // Third soft 403 unpairs
    await ctrl.pushPrinterStatusesIfChanged();
    assert.equal(store.readConfig().agent_token, "");

    // Fresh controller for immediate 401
    const store2 = memoryStore({
      agent_api_base: "https://api.example.com",
      agent_token: "tok2",
      branch_id: "147",
      is_print_host: true,
      host_epoch: 1,
    });
    statusMode = "401";
    const ctrl2 = createStationPrintingController({
      ...store2,
      log: () => {},
      sleep: async () => {},
      setTimeout: () => 1,
      clearTimeout: () => {},
      request: async (cfg) => {
        const url = String(cfg.url || "");
        if (url.includes("/status")) {
          return {
            status: 401,
            data: { error: { code: "UNAUTHORIZED", message: "revoked" } },
            headers: {},
          };
        }
        return { status: 200, data: {}, headers: {} };
      },
    });
    ctrl2.syncWindowsPrinters([{ name: "Bar" }]);
    const list2 = ctrl2.printers.list();
    ctrl2.printers.upsert({
      ...list2[0],
      external_id: list2[0].external_id,
      status: "error",
    });
    await ctrl2.pushPrinterStatusesIfChanged();
    assert.equal(store2.readConfig().agent_token, "");
  });

  it("source: noteSuccess on HB is not gated by consecutiveHbFailures", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "../src/station-printing.js"),
      "utf8"
    );
    // Ensure noteSuccess follows the recovery block, not only inside it.
    assert.match(
      src,
      /consecutiveHbFailures = 0;\s*\}\s*\/\/[\s\S]*?authUnpairTracker\.noteSuccess\(\)/
    );
    assert.match(src, /handleAuthFailure\(r,\s*"status_unauthorized"\)/);
    assert.match(
      src,
      /authUnpairTracker\.noteSuccess\(\);\s*if \(statusPushRetryTimer\)/
    );
  });
});
