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
  isRetryBudgetExhausted,
  shouldLogRetryFailure,
  MAX_ATTEMPTS,
  MAX_AGE_MS,
  DEAD_LETTER_NAME,
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
    const r1 = box.markAttempt("a", { ok: false, status: 500, error: "boom", jitter01: 0.5 });
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
    assert.equal(isTerminalAckStatus(408), false);
    assert.equal(isTerminalAckStatus(401), true);
    assert.equal(isTerminalAckStatus(403), true);
    assert.equal(isTerminalAckStatus(400), true);
    assert.equal(isTerminalAckStatus(503), false);
    assert.equal(nextBackoffMs(1, 0.5), 1000);
    assert.equal(nextBackoffMs(99, 0.5), 120000);
    assert.equal(nextBackoffMs(1, 0.0), 800);
    assert.equal(nextBackoffMs(1, 1.0), 1200);
  });

  it("persistent 500 stops at MAX_ATTEMPTS (bounded retry)", () => {
    const box = createAckOutbox({});
    box.enqueue({ jobId: "persist-500", status: "printed" });
    let last = null;
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      last = box.markAttempt("persist-500", {
        ok: false,
        status: 500,
        error: "boom",
        nowMs: Date.now(),
        jitter01: 0.5,
      });
      if (last && last.exhausted) break;
    }
    assert.ok(last);
    assert.equal(last.exhausted, true);
    assert.equal(last.deadLettered, true);
    assert.equal(last.removed, true);
    assert.equal(last.ok, false);
    assert.equal(last.entry.attempts, MAX_ATTEMPTS);
    assert.equal(box.has("persist-500"), false);
    assert.equal(box.size(), 0);
  });

  it("400 and 404 are terminal; 408 retries; 429 honors Retry-After", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ack-cls-"));
    const filePath = path.join(dir, "ack-outbox.json");
    const box = createAckOutbox({ filePath });

    box.enqueue({ jobId: "bad", status: "failed", reason: "x" });
    const r400 = box.markAttempt("bad", { ok: false, status: 400, error: "bad" });
    assert.equal(r400.removed, true);
    assert.equal(r400.ok, false);
    assert.equal(box.has("bad"), false);

    box.enqueue({ jobId: "gone", status: "printed" });
    const r404 = box.markAttempt("gone", { ok: false, status: 404, error: "nf" });
    assert.equal(r404.removed, true);
    assert.equal(box.has("gone"), false);

    box.enqueue({ jobId: "to", status: "printed" });
    const r408 = box.markAttempt("to", {
      ok: false,
      status: 408,
      error: "timeout",
      nowMs: 1_000_000,
      jitter01: 0.5,
    });
    assert.equal(r408.removed, false);
    assert.ok(box.get("to").nextAttemptAt > 1_000_000);

    box.enqueue({ jobId: "rl", status: "printed" });
    const r429 = box.markAttempt("rl", {
      ok: false,
      status: 429,
      error: "slow",
      nowMs: 2_000_000,
      jitter01: 0.5,
      retryAfterMs: 30_000,
    });
    assert.equal(r429.removed, false);
    // backoff for attempt 1 with jitter 0.5 is 1000; Retry-After 30s wins
    assert.equal(box.get("rl").nextAttemptAt, 2_000_000 + 30_000);
  });

  it("network error (null status) retries under the same budget", () => {
    const box = createAckOutbox({});
    box.enqueue({ jobId: "net", status: "printed" });
    const r = box.markAttempt("net", {
      ok: false,
      status: null,
      error: "ECONNRESET",
      jitter01: 0.5,
    });
    assert.equal(r.removed, false);
    assert.equal(box.has("net"), true);
  });

  it("persistent 500 dead-letters and releases the outbox slot", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ack-dl-"));
    const filePath = path.join(dir, "ack-outbox.json");
    const box = createAckOutbox({ filePath, deadLetterKeep: 10 });
    box.enqueue({ jobId: "poison", status: "printed" });
    let last = null;
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      last = box.markAttempt("poison", {
        ok: false,
        status: 500,
        error: "boom",
        nowMs: Date.now(),
        jitter01: 0.5,
      });
      if (last && last.exhausted) break;
    }
    assert.equal(last.deadLettered, true);
    assert.equal(box.size(), 0);
    const dead = box.listDeadLetters();
    assert.ok(dead.length >= 1);
    assert.equal(dead[dead.length - 1].jobId, "poison");
    assert.equal(dead[dead.length - 1].cause, "MAX_ATTEMPTS");
    assert.ok(fs.existsSync(path.join(dir, DEAD_LETTER_NAME)));
  });

  it("stops when MAX_AGE_MS exceeded", () => {
    const box = createAckOutbox({});
    box.enqueue({ jobId: "aged", status: "failed", reason: "x" });
    const created = box.get("aged").createdAt;
    const outcome = box.markAttempt("aged", {
      ok: false,
      status: 503,
      error: "unavailable",
      nowMs: created + MAX_AGE_MS + 1,
      jitter01: 0.5,
    });
    assert.equal(outcome.exhausted, true);
    assert.equal(outcome.removed, true);
    assert.equal(box.has("aged"), false);
  });

  it("isRetryBudgetExhausted and shouldLogRetryFailure helpers", () => {
    assert.equal(isRetryBudgetExhausted(1, 1000, 2000), false);
    assert.equal(isRetryBudgetExhausted(MAX_ATTEMPTS, 1000, 2000), true);
    assert.equal(isRetryBudgetExhausted(1, 1000, 1000 + MAX_AGE_MS), true);
    assert.equal(shouldLogRetryFailure(0), false);
    assert.equal(shouldLogRetryFailure(1), true);
    assert.equal(shouldLogRetryFailure(2), false);
    assert.equal(shouldLogRetryFailure(5), true);
  });

  it("listDue respects nextAttemptAt", () => {
    const box = createAckOutbox({});
    box.enqueue({ jobId: "soon", status: "printed" });
    box.markAttempt("soon", { ok: false, status: 500, error: "x", jitter01: 0.5 });
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

