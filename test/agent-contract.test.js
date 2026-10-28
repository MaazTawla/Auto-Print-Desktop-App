"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  parseHostConflictError,
  parsePrintMessage,
  buildRegisterRequest,
  buildAckRequest,
  ERROR_CODES,
  resolveApiUrl,
  ASSUMPTIONS,
} = require("../src/agent-contract");

describe("agent-contract", () => {
  it("parses 409 PRINT_HOST_ALREADY_CONFIGURED exactly", () => {
    const body = {
      error: {
        code: "PRINT_HOST_ALREADY_CONFIGURED",
        message: "Another device is already configured as print host for this branch.",
        current_host: {
          app_id: "aaa",
          device_label: "Front counter tablet - POS app",
          last_heartbeat_at: "2026-10-28T16:42:00+05:00",
          is_online: true,
        },
      },
    };
    const c = parseHostConflictError(body, 409);
    assert.equal(c.code, ERROR_CODES.PRINT_HOST_ALREADY_CONFIGURED);
    assert.equal(
      c.message,
      "Another device is already configured as print host for this branch."
    );
    assert.equal(c.current_host.device_label, "Front counter tablet - POS app");
    assert.equal(c.current_host.is_online, true);
  });

  it("parses v2 print message fields", () => {
    const msg = parsePrintMessage({
      schema_version: 2,
      job_id: "job-1",
      order_id: "F0052",
      printer_external_id: "Kitchen Printer 1",
      host_epoch: 7,
      delayed: true,
      ticket_type: "NEW",
      station_index: 1,
      station_count: 2,
      pdf_base64: "JVBERi0x",
    });
    assert.equal(msg.ok, true);
    assert.equal(msg.job_id, "job-1");
    assert.equal(msg.printer_external_id, "Kitchen Printer 1");
    assert.equal(msg.host_epoch, 7);
    assert.equal(msg.delayed, true);
    assert.equal(msg.station_index, 1);
  });

  it("buildRegisterRequest uses platform desktop", () => {
    const body = buildRegisterRequest({
      appId: "id-1",
      branchId: "147",
      deviceLabel: "PC",
      pairingCode: "PAIR",
    });
    assert.equal(body.platform, "desktop");
    assert.equal(body.role, ASSUMPTIONS.registerRole);
    assert.equal(body.pairing_code, "PAIR");
  });

  it("buildAckRequest printed/failed", () => {
    assert.deepEqual(buildAckRequest({ status: "printed" }).status, "printed");
    assert.equal(buildAckRequest({ status: "failed", reason: "jam" }).reason, "jam");
  });

  it("resolveApiUrl joins base and path", () => {
    const u = resolveApiUrl("https://api.example.com", "/register");
    assert.equal(u, "https://api.example.com/api/v1/print-agent/register");
  });
});
