"use strict";

/**
 * Shared HTTP outcome for print-agent calls (ACK outbox, heartbeat, sync, status).
 *
 * - 2xx → success
 * - null / network / timeout → retryable
 * - 408, 429 → retryable (429 honors Retry-After)
 * - other 4xx → terminal
 * - 5xx → retryable until caller budget, then dead-letter / give up
 * - Sync: 409 SYNC_CONFLICT stays retryable via isSyncConflictRetryable
 */

const Outcome = Object.freeze({
  SUCCESS: "SUCCESS",
  RETRYABLE: "RETRYABLE",
  TERMINAL: "TERMINAL",
});

function classify(status) {
  if (status == null || !Number.isFinite(Number(status))) return Outcome.RETRYABLE;
  const s = Number(status);
  if (s >= 200 && s < 300) return Outcome.SUCCESS;
  if (s === 408 || s === 429) return Outcome.RETRYABLE;
  if (s >= 400 && s < 500) return Outcome.TERMINAL;
  if (s >= 500 && s < 600) return Outcome.RETRYABLE;
  return Outcome.RETRYABLE;
}

function isTerminal(status) {
  return classify(status) === Outcome.TERMINAL;
}

function isRetryable(status) {
  return classify(status) === Outcome.RETRYABLE;
}

function isSuccess(status) {
  return classify(status) === Outcome.SUCCESS;
}

function isSyncConflictRetryable(status, errorCode) {
  return Number(status) === 409 && String(errorCode || "") === "SYNC_CONFLICT";
}

/**
 * Parse Retry-After (delta-seconds or HTTP-date). Cap at maxMs (default 120s).
 */
function parseRetryAfterMs(raw, nowMs = Date.now(), maxMs = 120000) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  // Delta-seconds: unsigned digits only. Signed forms ("+5", "-1") are absent —
  // never fall through to Date.parse (which maps "+5"/"-1" to a weird delay).
  if (/^\d+$/.test(s)) {
    const sec = Number(s);
    if (!Number.isFinite(sec) || sec < 0) return null;
    return Math.min(maxMs, Math.max(0, sec * 1000));
  }
  if (/^[+-]\d+$/.test(s)) return null;
  const then = Date.parse(s);
  if (!Number.isFinite(then)) return null;
  return Math.min(maxMs, Math.max(0, then - nowMs));
}

function delayMs(attempts, { jitter01 = 0.5, retryAfterMs = null, backoffMs } = {}) {
  const base = typeof backoffMs === "function" ? backoffMs(attempts, jitter01) : 1000;
  const ra = retryAfterMs != null && Number.isFinite(Number(retryAfterMs)) ? Number(retryAfterMs) : 0;
  return Math.max(1, base, ra);
}

/** Status-push fingerprint commit + retry helpers (mirrors Android PrinterStatusPushPolicy). */
const STATUS_PUSH_MAX_RETRY_MS = 20000;

function statusPushRetryMs(consecutiveFailures) {
  const n = Math.max(1, Number(consecutiveFailures) || 1);
  return Math.min(5000 * n, STATUS_PUSH_MAX_RETRY_MS);
}

function shouldLogStatusPushFailure(consecutiveFailures, everyNth = 3) {
  const n = Number(consecutiveFailures) || 0;
  if (n <= 0) return false;
  if (n === 1) return true;
  return n % everyNth === 0;
}

function shouldCommitStatusFingerprint(allSucceeded, attempted) {
  return Boolean(attempted && allSucceeded);
}


/**
 * Session unpair / clear-local-auth policy (L3).
 *
 * Immediate unpair:
 *   - HTTP 401 (UNAUTHORIZED / revoked / invalid bearer — contract revoke path)
 *   - HTTP 404 AGENT_NOT_FOUND (unknown host)
 *
 * Soft auth (count toward threshold, default 3):
 *   - HTTP 403 including FORBIDDEN / NOT_PRINT_HOST / BRANCH_MISMATCH / bare 403
 *   A single 403 FORBIDDEN on one job is terminal for that job only — no unpair
 *   until the consecutive soft-auth threshold is hit.
 *
 * Apply on every path (ACK, heartbeat, sync, status).
 */
const AUTH_UNPAIR_THRESHOLD = 3;
const IMMEDIATE_UNPAIR_CODES_404 = new Set(["AGENT_NOT_FOUND"]);

function normalizeErrorCode(code) {
  if (code == null) return null;
  const s = String(code).trim();
  return s ? s.toUpperCase() : null;
}

function shouldUnpairImmediately(status, errorCode) {
  const st = status == null ? null : Number(status);
  if (st === 401) return true;
  const code = normalizeErrorCode(errorCode);
  if (st === 404 && code && IMMEDIATE_UNPAIR_CODES_404.has(code)) return true;
  return false;
}

/** Auth-related signal worth tracking (not every 4xx). */
function isAuthRelated(status, errorCode) {
  const st = status == null ? null : Number(status);
  if (st === 401 || st === 403) return true;
  const code = normalizeErrorCode(errorCode);
  if (st === 404 && code && IMMEDIATE_UNPAIR_CODES_404.has(code)) return true;
  return false;
}

function isSoftAuthFailure(status, errorCode) {
  if (!isAuthRelated(status, errorCode)) return false;
  return !shouldUnpairImmediately(status, errorCode);
}

function createAuthUnpairTracker(opts = {}) {
  const threshold =
    opts.threshold != null ? Number(opts.threshold) : AUTH_UNPAIR_THRESHOLD;
  let consecutiveSoft = 0;

  function noteSuccess() {
    consecutiveSoft = 0;
    return { shouldUnpair: false, consecutiveSoft: 0, reason: null };
  }

  function noteFailure(status, errorCode) {
    if (!isAuthRelated(status, errorCode)) {
      return { shouldUnpair: false, consecutiveSoft, reason: null };
    }
    if (shouldUnpairImmediately(status, errorCode)) {
      consecutiveSoft = 0;
      const code = normalizeErrorCode(errorCode);
      return {
        shouldUnpair: true,
        consecutiveSoft: 0,
        immediate: true,
        reason:
          Number(status) === 401
            ? "unauthorized"
            : code || "agent_not_found",
      };
    }
    consecutiveSoft += 1;
    if (consecutiveSoft >= threshold) {
      const n = consecutiveSoft;
      consecutiveSoft = 0;
      return {
        shouldUnpair: true,
        consecutiveSoft: 0,
        immediate: false,
        reason: `soft_auth_x${n}`,
      };
    }
    return {
      shouldUnpair: false,
      consecutiveSoft,
      immediate: false,
      reason: null,
    };
  }

  function getConsecutiveSoft() {
    return consecutiveSoft;
  }

  return {
    noteSuccess,
    noteFailure,
    getConsecutiveSoft,
    threshold,
  };
}

module.exports = {
  Outcome,
  classify,
  isTerminal,
  isRetryable,
  isSuccess,
  isSyncConflictRetryable,
  parseRetryAfterMs,
  delayMs,
  STATUS_PUSH_MAX_RETRY_MS,
  statusPushRetryMs,
  shouldLogStatusPushFailure,
  shouldCommitStatusFingerprint,
  AUTH_UNPAIR_THRESHOLD,
  shouldUnpairImmediately,
  isAuthRelated,
  isSoftAuthFailure,
  createAuthUnpairTracker,
};
