"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  parseHostConflictError,
  parsePrintMessage,
  parseRegisterResponse,
  parseHeartbeatResponse,
  parsePrintersSyncResponse,
  buildRegisterRequest,
  buildAckRequest,
  buildHeartbeatRequest,
  buildPrintersSyncRequest,
  ERROR_CODES,
  resolveApiUrl,
  ASSUMPTIONS,
  ENDPOINTS,
  REMAINING_GAPS,
} = require("../src/agent-contract");

describe("agent-contract v1.0", () => {
  it("ASSUMPTIONS match Backend contract", () => {
    assert.equal(ASSUMPTIONS.contractVersion, "1.0");
    assert.equal(ASSUMPTIONS.apiBasePath, "/api/v1/print-agent");
    assert.equal(ASSUMPTIONS.heartbeatIntervalMs, 30000);
    assert.equal(ASSUMPTIONS.heartbeatTtlMs, 90000);
    assert.equal(ASSUMPTIONS.registerRole, "print_host");
    assert.equal(ASSUMPTIONS.pairingCodeRequired, true);
    assert.equal(ASSUMPTIONS.tokenField, "token");
    assert.equal(ASSUMPTIONS.agentResponsesFlat, true);
    assert.equal(ASSUMPTIONS.consumeExclusive, false);
    assert.equal(ASSUMPTIONS.prefetch, 1);
    assert.equal(ASSUMPTIONS.printersSyncKey, "external_id");
    assert.equal(ASSUMPTIONS.pdfDelivery, "url_or_base64");
    assert.ok(Array.isArray(REMAINING_GAPS));
  });

  it("endpoints are under /print-agent relative paths", () => {
    assert.equal(ENDPOINTS.register, "/register");
    assert.equal(ENDPOINTS.heartbeat, "/heartbeat");
    assert.equal(ENDPOINTS.deregister, "/deregister");
    assert.equal(ENDPOINTS.printersSync, "/printers/sync");
    assert.equal(ENDPOINTS.jobAck("abc"), "/jobs/abc/ack");
    assert.equal(ENDPOINTS.printerStatus(12), "/printers/12/status");
  });

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

  it("buildRegisterRequest requires pairing_code and device_label; role print_host", () => {
    const body = buildRegisterRequest({
      appId: "id-1",
      branchId: "147",
      deviceLabel: "PC",
      pairingCode: "PAIR",
    });
    assert.equal(body.platform, "desktop");
    assert.equal(body.role, "print_host");
    assert.equal(body.pairing_code, "PAIR");
    assert.equal(body.device_label, "PC");
    assert.equal(body.app_id, "id-1");
    assert.equal(body.branch_id, "147");
    assert.ok(!("host_epoch" in body));

    assert.throws(
      () => buildRegisterRequest({ appId: "x", deviceLabel: "PC" }),
      /pairing_code/
    );
    assert.throws(
      () =>
        buildRegisterRequest({
          appId: "x",
          pairingCode: "P",
          deviceLabel: "  ",
        }),
      /device_label/
    );
  });

  it("parseRegisterResponse reads flat token only (no access_token)", () => {
    const flat = parseRegisterResponse({
      token: "tok-flat",
      access_token: "should-ignore",
      is_print_host: true,
      host_epoch: 3,
      heartbeat_interval_seconds: 30,
      heartbeat_ttl_seconds: 90,
      rabbit: { host: "mq.example" },
    });
    assert.equal(flat.token, "tok-flat");
    assert.equal(flat.is_print_host, true);
    assert.equal(flat.host_epoch, 3);
    assert.equal(flat.heartbeat_ttl_seconds, 90);
    assert.equal(flat.rabbit.host, "mq.example");

    const enveloped = parseRegisterResponse({
      data: { token: "tok-env", is_print_host: false, host_epoch: 1 },
    });
    assert.equal(enveloped.token, "tok-env");
  });

  it("parseHeartbeatResponse is flat", () => {
    const hb = parseHeartbeatResponse({
      is_print_host: true,
      host_epoch: 4,
      pending_job_count: 2,
      server_time: "2026-10-28T12:00:00Z",
    });
    assert.equal(hb.is_print_host, true);
    assert.equal(hb.host_epoch, 4);
    assert.equal(hb.pending_job_count, 2);
  });

  it("buildHeartbeatRequest uses connection_type (+ connection alias)", () => {
    const body = buildHeartbeatRequest({
      appId: "a",
      branchId: "147",
      printers: [
        {
          external_id: "Kitchen",
          name: "Kitchen",
          connection: "usb",
          status: "out_of_paper",
          is_default: true,
        },
      ],
    });
    assert.equal(body.printers[0].connection_type, "usb");
    assert.equal(body.printers[0].connection, "usb");
    assert.equal(body.printers[0].status, "error");
    assert.equal(body.printers[0].status_detail, "Out of paper");
  });

  it("buildAckRequest includes optional printer_external_id", () => {
    assert.deepEqual(buildAckRequest({ status: "printed" }).status, "printed");
    const failed = buildAckRequest({
      status: "failed",
      reason: "jam",
      printerExternalId: "Kitchen",
      hostEpoch: 2,
    });
    assert.equal(failed.reason, "jam");
    assert.equal(failed.printer_external_id, "Kitchen");
    assert.equal(failed.host_epoch, 2);
  });

  it("parsePrintersSyncResponse stores server ids", () => {
    const sync = parsePrintersSyncResponse({
      accepted: 2,
      printers: [
        { id: 10, external_id: "A", name: "A", connection_type: "usb" },
        { id: 11, external_id: "B", name: "B", connection_type: "lan" },
      ],
    });
    assert.equal(sync.accepted, 2);
    assert.equal(sync.printers[0].id, 10);
    assert.equal(sync.printers[1].external_id, "B");
  });

  it("buildPrintersSyncRequest keyed by external_id", () => {
    const body = buildPrintersSyncRequest({
      printers: [{ external_id: "K1", name: "Kitchen", connection_type: "lan" }],
    });
    assert.equal(body.printers[0].external_id, "K1");
    assert.equal(body.printers[0].connection_type, "lan");
  });

  it("parses v2 print message fields including pdf_url and station_name", () => {
    const msg = parsePrintMessage({
      schema_version: 2,
      job_id: "job-1",
      order_id: "F0052",
      printer_external_id: "Kitchen Printer 1",
      host_epoch: 7,
      delayed: true,
      ticket_type: "new",
      station_index: 1,
      station_count: 2,
      station_name: "Kitchen",
      pdf_url: "https://cdn.example/x.pdf",
      pdf_sha256: "abc",
    });
    assert.equal(msg.ok, true);
    assert.equal(msg.job_id, "job-1");
    assert.equal(msg.printer_external_id, "Kitchen Printer 1");
    assert.equal(msg.host_epoch, 7);
    assert.equal(msg.delayed, true);
    assert.equal(msg.station_index, 1);
    assert.equal(msg.station_name, "Kitchen");
    assert.equal(msg.pdf_url, "https://cdn.example/x.pdf");
    assert.equal(msg.pdf_sha256, "abc");
    assert.equal(msg.pdf_base64, "");
  });

  it("parsePrintMessage supports pdf_base64 and nested pdf", () => {
    const b64 = parsePrintMessage({
      schema_version: 2,
      job_id: "j2",
      printer_external_id: "P",
      host_epoch: 1,
      delayed: false,
      ticket_type: "new",
      station_index: 0,
      station_count: 1,
      pdf_base64: "JVBERi0x",
    });
    assert.equal(b64.pdf_base64, "JVBERi0x");
    assert.equal(b64.pdf_url, null);

    const nested = parsePrintMessage({
      schema_version: 2,
      job_id: "j3",
      printer: { external_id: "NestP" },
      station: { index: 2, count: 3, name: "Bar" },
      pdf: { url: "https://x/y.pdf", sha256: "dead" },
      host_epoch: 1,
      delayed: false,
      ticket_type: "addition",
      station_index: 2,
      station_count: 3,
      station_name: "Bar",
      printer_external_id: "NestP",
    });
    assert.equal(nested.pdf_url, "https://x/y.pdf");
    assert.equal(nested.printer_external_id, "NestP");
    assert.equal(nested.station_name, "Bar");
  });

  it("resolveApiUrl joins base and path under /api/v1/print-agent", () => {
    const u = resolveApiUrl("https://api.example.com", "/register");
    assert.equal(u, "https://api.example.com/api/v1/print-agent/register");
  });
});
