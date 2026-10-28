"use strict";

/**
 * Crash window: printing marker set, process dies before mark(processed).
 * Redelivery must not auto-print; fail-ack PRINT_INTERRUPTED via outbox, then mark processed.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createProcessedJobsStore } = require("../src/processed-jobs");
const { createAckOutbox } = require("../src/ack-outbox");
const { ERROR_CODES } = require("../src/agent-contract");

describe("PRINT_INTERRUPTED crash window", () => {
  it("fail-acks via outbox and marks processed without reprinting", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "print-int-"));
    const processed = createProcessedJobsStore({
      filePath: path.join(dir, "processed-jobs.json"),
    });
    const outbox = createAckOutbox({
      filePath: path.join(dir, "ack-outbox.json"),
    });

    // Prior session crashed after markPrinting
    processed.markPrinting("job-42");

    // Redelivery decision (mirrors main.js handleMessage)
    assert.equal(processed.has("job-42"), false);
    assert.equal(processed.isPrinting("job-42"), true);

    // Do NOT print — fail-ack + mark processed (finalizeServerAck order)
    processed.mark("job-42");
    const entry = outbox.enqueue({
      jobId: "job-42",
      status: "failed",
      reason: ERROR_CODES.PRINT_INTERRUPTED,
      printerExternalId: "win:Kitchen",
    });
    assert.equal(entry.status, "failed");
    assert.equal(entry.reason, "PRINT_INTERRUPTED");
    assert.equal(processed.has("job-42"), true);
    assert.equal(processed.isPrinting("job-42"), false);

    const pending = outbox.listAll();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].reason, ERROR_CODES.PRINT_INTERRUPTED);
  });
});
