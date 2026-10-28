"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const {
  parseHostConflictError,
  parseSyncConflictError,
  syncConflictBackoffMs,
  parsePrintMessage,
  parseRegisterResponse,
  parseHeartbeatResponse,
  parsePrintersSyncResponse,
  parseAckResponse,
  parseAgentError,
  buildRegisterRequest,
  buildAckRequest,
  buildHeartbeatRequest,
  buildPrintersSyncRequest,
  normalizeRabbitConfig,
  rabbitConfigToPersistPatch,
  resolveQueueDeclareOptions,
  resolveQueueName,
  verifyPdfChecksum,
  classifyPdfUrlHttpStatus,
  ERROR_CODES,
  resolveApiUrl,
  ASSUMPTIONS,
  ENDPOINTS,
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
    assert.equal(ASSUMPTIONS.consumeExclusive, false);
    assert.equal(ASSUMPTIONS.prefetch, 1);
    assert.equal(ASSUMPTIONS.applyRabbitFromRegister, true);
    assert.equal(ASSUMPTIONS.pdfSha256MismatchFails, true);
    assert.equal(ASSUMPTIONS.pdfUrlRequiresBearer, true);
    assert.equal(ASSUMPTIONS.resumeViaHeartbeat, true);
    assert.equal(ASSUMPTIONS.appIdStableAcrossUpdates, true);
  });

  it("endpoints are under /print-agent relative paths", () => {
    assert.equal(ENDPOINTS.register, "/register");
    assert.equal(ENDPOINTS.jobAck("abc"), "/jobs/abc/ack");
  });

  it("buildRegisterRequest requires pairing_code", () => {
    assert.throws(
      () => buildRegisterRequest({ appId: "x", deviceLabel: "PC" }),
      (err) => err.code === ERROR_CODES.PAIRING_CODE_REQUIRED
    );
    const body = buildRegisterRequest({
      appId: "id-1",
      branchId: "147",
      deviceLabel: "PC",
      pairingCode: "PAIR",
    });
    assert.equal(body.role, "print_host");
    assert.equal(body.pairing_code, "PAIR");
  });

  it("parseRegisterResponse normalizes rabbit.queue with Branch fallback", () => {
    const parsed = parseRegisterResponse({
      token: "tok",
      is_print_host: true,
      host_epoch: 2,
      branch_id: 147,
      rabbit: {
        host: "mq.example.com",
        port: 5672,
        username: "u",
        password: "p",
        exchange: "auto_print",
        routing_key: "orders.147",
        queue_durable: true,
        queue_arguments: { "x-single-active-consumer": true },
        consume_exclusive: false,
        prefetch: 1,
      },
    });
    assert.equal(parsed.token, "tok");
    assert.equal(parsed.rabbitConfig.queue, "printer.Branch.147");
    assert.equal(parsed.rabbitConfig.queue_durable, true);
    assert.equal(parsed.rabbitConfig.queue_arguments["x-single-active-consumer"], true);
    assert.equal(parsed.rabbitConfig.hasBrokerCreds, true);
    assert.equal(parsed.pdf_host, null);

    const withPdfHost = parseRegisterResponse({
      token: "tok2",
      is_print_host: true,
      host_epoch: 1,
      branch_id: 1,
      pdf_host: "https://api.tawla.io",
      rabbit: { queue: "q1" },
    });
    assert.equal(withPdfHost.pdf_host, "https://api.tawla.io");

    const withQueue = normalizeRabbitConfig({ queue: "custom.q" }, 9);
    assert.equal(withQueue.queue, "custom.q");
  });

  it("rabbitConfigToPersistPatch and resolveQueue* persist declare options", () => {
    const cfg = normalizeRabbitConfig(
      {
        host: "h",
        port: 5672,
        username: "u",
        password: "secret",
        exchange: "auto_print",
        routing_key: "orders.1",
        queue: "printer.Branch.1",
        queue_durable: true,
        queue_arguments: { "x-single-active-consumer": true },
      },
      1
    );
    const patch = rabbitConfigToPersistPatch(cfg);
    assert.equal(patch.rabbit_host, "h");
    assert.equal(patch.rabbit_password, "secret");
    assert.equal(patch.rabbit_queue, "printer.Branch.1");
    assert.equal(patch.rabbit_queue_durable, true);
    assert.deepEqual(patch.rabbit_queue_arguments, {
      "x-single-active-consumer": true,
    });
    const declare = resolveQueueDeclareOptions(patch);
    assert.equal(declare.durable, true);
    assert.equal(declare.arguments["x-single-active-consumer"], true);
    assert.equal(resolveQueueName({}, 55), "printer.Branch.55");
    assert.equal(resolveQueueName({ rabbit_queue: "q.x" }, 55), "q.x");
  });

  it("parseAckResponse surfaces flat success and error code/message", () => {
    const ok = parseAckResponse({ id: 901, status: "printed", attempts: 1 }, 200);
    assert.equal(ok.ok, true);
    assert.equal(ok.status, "printed");
    const fail = parseAckResponse(
      { error: { code: "NOT_PRINT_HOST", message: "Only host may ack" } },
      403
    );
    assert.equal(fail.ok, false);
    assert.equal(fail.error.code, "NOT_PRINT_HOST");
    assert.equal(fail.error.message, "Only host may ack");
  });

  it("parseAgentError reads { error: { code, message } }", () => {
    const e = parseAgentError(
      { error: { code: "PAIRING_CODE_INVALID", message: "bad code" } },
      401
    );
    assert.equal(e.code, "PAIRING_CODE_INVALID");
    assert.equal(e.message, "bad code");
  });

  it("buildAckRequest includes printer_external_id", () => {
    const body = buildAckRequest({
      status: "failed",
      reason: "PDF_CHECKSUM_MISMATCH",
      printerExternalId: "K1",
    });
    assert.equal(body.printer_external_id, "K1");
    assert.equal(body.reason, "PDF_CHECKSUM_MISMATCH");
  });

  it("buildHeartbeatRequest maps out_of_paper to error", () => {
    const body = buildHeartbeatRequest({
      printers: [{ external_id: "A", name: "A", status: "out_of_paper" }],
    });
    assert.equal(body.printers[0].status, "error");
    assert.equal(body.printers[0].connection_type, "lan");
  });

  it("parses v2 message with pdf_url and station_name", () => {
    const msg = parsePrintMessage({
      schema_version: 2,
      job_id: "j1",
      order_id: "F1",
      printer_external_id: "P",
      host_epoch: 1,
      delayed: true,
      ticket_type: "new",
      station_index: 0,
      station_count: 1,
      station_name: "Kitchen",
      pdf_url: "https://x/y.pdf",
      pdf_sha256: "abc",
    });
    assert.equal(msg.pdf_url, "https://x/y.pdf");
    assert.equal(msg.delayed, true);
    assert.equal(msg.station_name, "Kitchen");
  });

  it("verifyPdfChecksum fails closed with PDF_CHECKSUM_MISMATCH", () => {
    const buf = Buffer.from("%PDF-1.4");
    const good = crypto.createHash("sha256").update(buf).digest("hex");
    assert.equal(verifyPdfChecksum(buf, good).ok, true);
    const bad = verifyPdfChecksum(buf, "deadbeef");
    assert.equal(bad.ok, false);
    assert.equal(bad.reason, ERROR_CODES.PDF_CHECKSUM_MISMATCH);
  });

  it("classifyPdfUrlHttpStatus treats 403/410 as PDF_URL_EXPIRED", () => {
    assert.equal(classifyPdfUrlHttpStatus(403).expired, true);
    assert.equal(classifyPdfUrlHttpStatus(410).reason, ERROR_CODES.PDF_URL_EXPIRED);
    assert.equal(classifyPdfUrlHttpStatus(200).expired, false);
    assert.equal(classifyPdfUrlHttpStatus(500).expired, false);
  });

  it("parses 409 PRINT_HOST_ALREADY_CONFIGURED", () => {
    const c = parseHostConflictError(
      {
        error: {
          code: "PRINT_HOST_ALREADY_CONFIGURED",
          message: "Another device is already configured as print host for this branch.",
          current_host: { app_id: "a", device_label: "Old PC", is_online: false },
        },
      },
      409
    );
    assert.equal(c.code, ERROR_CODES.PRINT_HOST_ALREADY_CONFIGURED);
    assert.equal(c.current_host.device_label, "Old PC");
  });

  it("resolveApiUrl joins base under /api/v1/print-agent", () => {
    assert.equal(
      resolveApiUrl("https://api.example.com", "/register"),
      "https://api.example.com/api/v1/print-agent/register"
    );
  });

  it("parsePrintersSyncResponse returns server ids", () => {
    const s = parsePrintersSyncResponse({
      accepted: 1,
      printers: [{ id: 9, external_id: "K", name: "K" }],
    });
    assert.equal(s.printers[0].id, 9);
  });

  it("parseHeartbeatResponse is flat", () => {
    const hb = parseHeartbeatResponse({
      is_print_host: true,
      host_epoch: 3,
      pending_job_count: 2,
    });
    assert.equal(hb.host_epoch, 3);
    assert.equal(hb.pending_job_count, 2);
  });

  it("buildPrintersSyncRequest keyed by external_id", () => {
    const body = buildPrintersSyncRequest({
      printers: [{ external_id: "e1", name: "N", connection_type: "usb" }],
    });
    assert.equal(body.printers[0].external_id, "e1");
  });
});

describe("ERROR_CODES.PRINT_INTERRUPTED", () => {
  it("is defined for crash-window fail-ack", () => {
    assert.equal(ERROR_CODES.PRINT_INTERRUPTED, "PRINT_INTERRUPTED");
  });
});

describe("ERROR_CODES.INVALID_PDF", () => {
  it("is defined for %PDF header fail-ack", () => {
    assert.equal(ERROR_CODES.INVALID_PDF, "INVALID_PDF");
  });
});

describe("SYNC_CONFLICT vs PRINT_HOST_ALREADY_CONFIGURED", () => {
  it("ERROR_CODES.SYNC_CONFLICT is defined", () => {
    assert.equal(ERROR_CODES.SYNC_CONFLICT, "SYNC_CONFLICT");
  });

  it("parseSyncConflictError reads error.code SYNC_CONFLICT", () => {
    const c = parseSyncConflictError(
      { error: { code: "SYNC_CONFLICT", message: "deadlock retry exhausted" } },
      409
    );
    assert.ok(c);
    assert.equal(c.code, ERROR_CODES.SYNC_CONFLICT);
    assert.match(c.message, /deadlock/i);
  });

  it("parseHostConflictError returns null for SYNC_CONFLICT", () => {
    const h = parseHostConflictError(
      { error: { code: "SYNC_CONFLICT", message: "x" } },
      409
    );
    assert.equal(h, null);
  });

  it("parseHostConflictError still parses PRINT_HOST_ALREADY_CONFIGURED", () => {
    const h = parseHostConflictError(
      {
        error: {
          code: "PRINT_HOST_ALREADY_CONFIGURED",
          message: "taken",
          current_host: { app_id: "other", device_label: "Old", is_online: true },
        },
      },
      409
    );
    assert.equal(h.code, ERROR_CODES.PRINT_HOST_ALREADY_CONFIGURED);
    assert.equal(h.current_host.app_id, "other");
  });

  it("syncConflictBackoffMs is short and jittered", () => {
    const a = syncConflictBackoffMs(1, () => 0);
    const b = syncConflictBackoffMs(1, () => 0.999);
    assert.equal(a, 200);
    assert.ok(b >= 200 && b < 400);
    const c = syncConflictBackoffMs(2, () => 0);
    assert.equal(c, 500);
  });
});

