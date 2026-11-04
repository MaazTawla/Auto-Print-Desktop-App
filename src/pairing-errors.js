/**
 * Register/pairing error policy (BE contract v1.21), aligned with the Android app
 * (PairingErrorMapper, PairingBusyRetry, PairingCodeClear).
 *
 * - 429 PAIRING_RATE_LIMITED: friendly wait message; never a bad code; never clears the code.
 * - 409 PAIRING_BUSY: temporary; retried with jitter (4 calls max, 3 pauses of 0.5–1.5s).
 * - 401 PAIRING_CODE_INVALID / PAIRING_CODE_EXPIRED / 401 with no code: the code is dead.
 * - Backend messages are never shown for these cases.
 */

"use strict";

const CODE_RATE_LIMITED = "PAIRING_RATE_LIMITED";
const CODE_BUSY = "PAIRING_BUSY";
const CODE_INVALID = "PAIRING_CODE_INVALID";
const CODE_EXPIRED = "PAIRING_CODE_EXPIRED";
const CODE_IN_FLIGHT = "REGISTER_IN_FLIGHT";
const CODE_REGISTER_CONFLICT_UNKNOWN = "REGISTER_CONFLICT";

const BUSY_MAX_RETRIES = 3;
const BUSY_MIN_DELAY_MS = 500;
const BUSY_MAX_DELAY_MS = 1500;

const MSG_SERVER_BUSY = "Server busy, please try again.";
const MSG_CODE_INVALID =
  "This pairing code is expired or already used. Generate a new code in Tawla Settings \u2192 Print host on the web, then enter it again.";
const MSG_CONFLICT_UNKNOWN =
  "The server could not complete pairing right now. Please try again.";

/** Upper-cased code; parseAgentError's synthetic "HTTP_<status>" counts as no code. */
function normCode(code) {
  const c = code == null ? "" : String(code).trim().toUpperCase();
  return /^HTTP_\d+$/.test(c) ? "" : c;
}

function rateLimitedMessage(retryAfterSeconds) {
  const n = Number(retryAfterSeconds);
  const s = Number.isFinite(n) && n > 0 ? Math.ceil(n) : null;
  if (s == null) {
    return "Too many pairing attempts. Please wait a moment, then try again.";
  }
  if (s < 60) {
    return `Too many pairing attempts. Please wait ${s} second${s === 1 ? "" : "s"}, then try again.`;
  }
  const m = Math.ceil(s / 60);
  return `Too many pairing attempts. Please wait about ${m} minute${m === 1 ? "" : "s"}, then try again.`;
}

/** Body retry_after_seconds wins; else Retry-After header (ms → s, rounded up). */
function retryAfterSeconds(bodySeconds, headerMs) {
  const b = Number(bodySeconds);
  if (bodySeconds != null && Number.isFinite(b) && b > 0) return Math.ceil(b);
  const h = Number(headerMs);
  if (headerMs != null && Number.isFinite(h) && h > 0) return Math.ceil(h / 1000);
  return null;
}

function isRateLimited(status, code) {
  return Number(status) === 429 || normCode(code) === CODE_RATE_LIMITED;
}

function isBusy(status, code) {
  return Number(status) === 409 && normCode(code) === CODE_BUSY;
}

/** Dead code → clear it. A 429 (any code) never counts as dead. */
function isCodeRejected(status, code) {
  if (isRateLimited(status, code)) return false;
  const c = normCode(code);
  return (
    c === CODE_INVALID ||
    c === CODE_EXPIRED ||
    (Number(status) === 401 && c === "")
  );
}

/** Only clear the stored code if it is still the one that was sent. */
function shouldClearCode(storedCode, sentCode) {
  const sent = sentCode == null ? "" : String(sentCode).trim();
  const stored = storedCode == null ? "" : String(storedCode).trim();
  return sent !== "" && stored === sent;
}

function jitterDelayMs(randomFn = Math.random) {
  const r = Number(randomFn());
  const u = Number.isFinite(r) ? Math.min(Math.max(r, 0), 1) : 0.5;
  return Math.round(BUSY_MIN_DELAY_MS + u * (BUSY_MAX_DELAY_MS - BUSY_MIN_DELAY_MS));
}

/** Runs attempt once, then up to maxRetries more times while it returns 409 PAIRING_BUSY. */
async function runBusyRetry(attempt, opts = {}) {
  const maxRetries = opts.maxRetries != null ? opts.maxRetries : BUSY_MAX_RETRIES;
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const delayMs = opts.delayMs || (() => jitterDelayMs(opts.random));
  let result = await attempt();
  let retries = 0;
  while (result && !result.ok && isBusy(result.status, result.code) && retries < maxRetries) {
    await sleep(delayMs());
    retries++;
    result = await attempt();
  }
  return result;
}

/**
 * Friendly { code, message } for a failed register, or null when the
 * existing (non-pairing) message should be kept.
 */
function friendlyRegisterError(result) {
  if (!result || result.ok) return null;
  const status = Number(result.status);
  const code = normCode(result.code || (result.error && result.error.code));
  if (code === CODE_IN_FLIGHT) {
    return { code: CODE_IN_FLIGHT, message: "Pairing is already in progress. Please wait." };
  }
  if (isBusy(status, code)) return { code: CODE_BUSY, message: MSG_SERVER_BUSY };
  if (isRateLimited(status, code)) {
    return {
      code: CODE_RATE_LIMITED,
      message: rateLimitedMessage(result.retryAfterSeconds),
      retryAfterSeconds: result.retryAfterSeconds != null ? result.retryAfterSeconds : null,
    };
  }
  if (isCodeRejected(status, code)) {
    return { code: code || CODE_INVALID, message: MSG_CODE_INVALID };
  }
  if (status === 409) {
    return { code: code || CODE_REGISTER_CONFLICT_UNKNOWN, message: MSG_CONFLICT_UNKNOWN };
  }
  return null;
}

module.exports = {
  CODE_RATE_LIMITED,
  CODE_BUSY,
  CODE_INVALID,
  CODE_EXPIRED,
  CODE_IN_FLIGHT,
  CODE_REGISTER_CONFLICT_UNKNOWN,
  BUSY_MAX_RETRIES,
  BUSY_MIN_DELAY_MS,
  BUSY_MAX_DELAY_MS,
  MSG_SERVER_BUSY,
  MSG_CODE_INVALID,
  MSG_CONFLICT_UNKNOWN,
  rateLimitedMessage,
  retryAfterSeconds,
  isRateLimited,
  isBusy,
  isCodeRejected,
  shouldClearCode,
  jitterDelayMs,
  runBusyRetry,
  friendlyRegisterError,
};
