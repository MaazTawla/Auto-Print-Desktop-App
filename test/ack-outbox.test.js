"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  createAckOutbox,
  isTerminalAckStatus,
  isSuccessAckStatus,
  nextBackoffMs,
} = require("../src/ack-outbox");

describe("ack-outbox", () => {
  it("enqueues durably and survives reload", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ack-"));
    const filePath = path.join(dir, "ack-outbox.json");
    const box = createAckOutbox({ filePath });
    const entry = box.enqueue({
      jobId: "j1",
      status: "printed",
      printerExternalId: "win:Kitchen",
    });
    assert.ok(entry);
    assert.equal(box.has("j1"), true);
    assert.equal(fs.existsSync(filePath), true);

    const box2 = createAckOutbox({ filePath });
    assert.equal(box2.has("j1"), true);
    assert.equal(box2.get("j1").status, "printed");
  });

  it("markAttempt removes on 2xx and terminal 4xx; retries otherwise", () => {
    const box = createAckOutbox({});
    box.enqueue({ jobId: "a", status: "failed", reason: "x" });
    const r1 = box.markAttempt("a", { ok: false, status: 500, error: "boom" });
    assert.equal(r1.removed, false);
    assert.equal(box.has("a"), true);
    assert.ok(box.get("a").nextAttemptAt > Date.now());

    box.enqueue({ jobId: "b", status: "printed" });
    const r2 = box.markAttempt("b", { ok: true, status: 200 });
    assert.equal(r2.removed, true);
    assert.equal(box.has("b"), false);

    box.enqueue({ jobId: "c", status: "failed", reason: "gone" });
    const r3 = box.markAttempt("c", { ok: false, status: 404, error: "not found" });
    assert.equal(r3.removed, true);
    assert.equal(box.has("c"), false);
  });

  it("classifies terminal vs retryable statuses", () => {
    assert.equal(isSuccessAckStatus(204), true);
    assert.equal(isTerminalAckStatus(404), true);
    assert.equal(isTerminalAckStatus(422), true);
    assert.equal(isTerminalAckStatus(429), false);
    assert.equal(isTerminalAckStatus(401), false);
    assert.equal(isTerminalAckStatus(503), false);
    assert.ok(nextBackoffMs(1) >= 1000);
    assert.ok(nextBackoffMs(99) >= 120000);
  });

  it("listDue respects nextAttemptAt", () => {
    const box = createAckOutbox({});
    box.enqueue({ jobId: "soon", status: "printed" });
    box.markAttempt("soon", { ok: false, status: 500, error: "x" });
    const dueNow = box.listDue(Date.now());
    assert.equal(dueNow.length, 0);
    const dueLater = box.listDue(Date.now() + 10 * 60 * 1000);
    assert.equal(dueLater.length, 1);
  });
});

describe("ack-outbox corrupt JSON (L1)", () => {
  it("quarantines to outbox.corrupt-<ts>.json, starts fresh, surfaces info", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ack-corrupt-"));
    const filePath = path.join(dir, "ack-outbox.json");
    fs.writeFileSync(filePath, "{not-json", "utf8");
    const events = [];
    const box = createAckOutbox({
      filePath,
      onCorrupt: (info) => events.push(info),
    });
    assert.equal(events.length, 1);
    assert.ok(events[0].quarantinedPath.includes("outbox.corrupt-"));
    assert.equal(fs.existsSync(events[0].quarantinedPath), true);
    assert.equal(fs.existsSync(filePath), false);
    assert.equal(box.size(), 0);
    assert.ok(box.getCorruptInfo());
    assert.equal(box.getCorruptInfo().quarantinedPath, events[0].quarantinedPath);
    // Fresh outbox still works
    box.enqueue({ jobId: "j-new", status: "failed", reason: "PRINT_INTERRUPTED" });
    assert.equal(box.has("j-new"), true);
    assert.equal(fs.existsSync(filePath), true);
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    assert.equal(raw.entries.length, 1);
  });
});

