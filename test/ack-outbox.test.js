"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  createAckOutbox,
  pruneCorruptQuarantines,
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

describe("ack-outbox quarantine cap (r4 L)", () => {
  it("keeps newest 10 outbox.corrupt-* and deletes older", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ack-prune-"));
    const filePath = path.join(dir, "ack-outbox.json");
    // Seed 12 quarantine files with increasing timestamps
    for (let i = 1; i <= 12; i++) {
      fs.writeFileSync(path.join(dir, `outbox.corrupt-${1000 + i}.json`), `{${i}`, "utf8");
    }
    // Trigger quarantine of current corrupt outbox → 13th file then prune to 10
    fs.writeFileSync(filePath, "NOT_JSON", "utf8");
    const box = createAckOutbox({ filePath, corruptKeep: 10 });
    const left = fs.readdirSync(dir).filter((n) => n.startsWith("outbox.corrupt-"));
    assert.equal(left.length, 10);
    assert.ok(box.getCorruptInfo());
    // Newest timestamps kept (includes the just-quarantined file with Date.now() ts)
    const ts = left
      .map((n) => Number((n.match(/outbox\.corrupt-(\d+)/) || [])[1]))
      .sort((a, b) => b - a);
    assert.ok(ts[0] >= ts[9]);
    assert.ok(!left.includes("outbox.corrupt-1001.json")); // oldest pruned
    assert.ok(!left.includes("outbox.corrupt-1002.json"));
  });

  it("pruneCorruptQuarantines helper deletes beyond keep", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ack-prune2-"));
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(path.join(dir, `outbox.corrupt-${i}.json`), "x", "utf8");
    }
    const r = pruneCorruptQuarantines(dir, 2);
    assert.equal(r.kept, 2);
    assert.equal(r.deleted.length, 3);
    assert.equal(fs.readdirSync(dir).filter((n) => n.startsWith("outbox.corrupt-")).length, 2);
  });
});

