"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  classify,
  Outcome,
  isTerminal,
  isRetryable,
  parseRetryAfterMs,
  isSyncConflictRetryable,
  shouldCommitStatusFingerprint,
  statusPushRetryMs,
  shouldLogStatusPushFailure,
} = require("../src/agent-http-retry-policy");

describe("agent-http-retry-policy", () => {
  it("classifies 2xx / 4xx / 5xx / network", () => {
    assert.equal(classify(200), Outcome.SUCCESS);
    assert.equal(classify(204), Outcome.SUCCESS);
    assert.equal(classify(400), Outcome.TERMINAL);
    assert.equal(classify(401), Outcome.TERMINAL);
    assert.equal(classify(403), Outcome.TERMINAL);
    assert.equal(classify(404), Outcome.TERMINAL);
    assert.equal(classify(422), Outcome.TERMINAL);
    assert.equal(classify(408), Outcome.RETRYABLE);
    assert.equal(classify(429), Outcome.RETRYABLE);
    assert.equal(classify(500), Outcome.RETRYABLE);
    assert.equal(classify(503), Outcome.RETRYABLE);
    assert.equal(classify(null), Outcome.RETRYABLE);
    assert.equal(isTerminal(404), true);
    assert.equal(isRetryable(500), true);
    assert.equal(isRetryable(null), true);
  });

  it("parses Retry-After delta-seconds and caps", () => {
    assert.equal(parseRetryAfterMs("5"), 5000);
    assert.equal(parseRetryAfterMs("0"), 0);
    assert.equal(parseRetryAfterMs("9999", Date.now(), 120000), 120000);
    assert.equal(parseRetryAfterMs(""), null);
    assert.equal(parseRetryAfterMs(null), null);
  });

  it("SYNC_CONFLICT 409 is retryable for sync path", () => {
    assert.equal(isSyncConflictRetryable(409, "SYNC_CONFLICT"), true);
    assert.equal(isSyncConflictRetryable(409, "OTHER"), false);
    assert.equal(isTerminal(409), true); // generic 4xx terminal; sync special-cases
  });

  it("status fingerprint commit + retry helpers", () => {
    assert.equal(shouldCommitStatusFingerprint(true, true), true);
    assert.equal(shouldCommitStatusFingerprint(false, true), false);
    assert.equal(shouldCommitStatusFingerprint(true, false), false);
    assert.equal(statusPushRetryMs(1), 5000);
    assert.equal(statusPushRetryMs(10), 20000);
    assert.equal(shouldLogStatusPushFailure(1), true);
    assert.equal(shouldLogStatusPushFailure(2), false);
    assert.equal(shouldLogStatusPushFailure(3), true);
  });
});
