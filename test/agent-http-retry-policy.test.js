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
  shouldUnpairImmediately,
  isAuthRelated,
  isSoftAuthFailure,
  createAuthUnpairTracker,
  AUTH_UNPAIR_THRESHOLD,
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
    // L4: negative / signed integers are absent (not Date.parse → 0)
    assert.equal(parseRetryAfterMs("-1"), null);
    assert.equal(parseRetryAfterMs("-5"), null);
  });

  it("SYNC_CONFLICT 409 is retryable for sync path", () => {
    assert.equal(isSyncConflictRetryable(409, "SYNC_CONFLICT"), true);
    assert.equal(isSyncConflictRetryable(409, "OTHER"), false);
    assert.equal(isTerminal(409), true); // generic 4xx terminal; sync special-cases
  });

  it("unpair: 401 and AGENT_NOT_FOUND immediate; 403 FORBIDDEN soft until threshold", () => {
    assert.equal(shouldUnpairImmediately(401, "UNAUTHORIZED"), true);
    assert.equal(shouldUnpairImmediately(401, null), true);
    assert.equal(shouldUnpairImmediately(404, "AGENT_NOT_FOUND"), true);
    assert.equal(shouldUnpairImmediately(403, "FORBIDDEN"), false);
    assert.equal(shouldUnpairImmediately(403, "NOT_PRINT_HOST"), false);
    assert.equal(shouldUnpairImmediately(403, "BRANCH_MISMATCH"), false);
    assert.equal(shouldUnpairImmediately(404, "NOT_FOUND"), false);
    assert.equal(isSoftAuthFailure(403, "FORBIDDEN"), true);
    assert.equal(isAuthRelated(403, "FORBIDDEN"), true);
    assert.equal(AUTH_UNPAIR_THRESHOLD, 3);

    const t = createAuthUnpairTracker();
    assert.equal(t.noteFailure(403, "FORBIDDEN").shouldUnpair, false);
    assert.equal(t.noteFailure(403, "FORBIDDEN").shouldUnpair, false);
    const third = t.noteFailure(403, "FORBIDDEN");
    assert.equal(third.shouldUnpair, true);
    assert.equal(third.immediate, false);

    const t2 = createAuthUnpairTracker();
    t2.noteFailure(403, "FORBIDDEN");
    t2.noteSuccess();
    assert.equal(t2.noteFailure(403, "FORBIDDEN").shouldUnpair, false);

    const t3 = createAuthUnpairTracker();
    assert.equal(t3.noteFailure(401, "UNAUTHORIZED").shouldUnpair, true);
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
