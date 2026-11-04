/**
 * Register/pairing error policy (BE contract v1.21), aligned with the Android app
 * (PairingErrorMapper, PairingBusyRetry, PairingCodeClear).
 *
 * - 429 PAIRING_RATE_LIMITED: friendly wait message; never a bad code; never clears the code.
 * - 409 PAIRING_BUSY: one attempt, "Server busy, please try again."; never auto-retried (v1.23:
 *   BUSY, BRANCH_MISMATCH and PRINT_HOST_ALREADY_CONFIGURED share a 5-failure budget per code,
 *   after which the code returns 401 PAIRING_CODE_INVALID). The user retries by hand.
 * - 401 PAIRING_CODE_INVALID / PAIRING_CODE_EXPIRED / 401 with no code: the code is dead.
 * - Backend messages are never shown for these cases.
 */

"use strict";

const CODE_RATE_LIMITED = "PAIRING_RATE_LIMITED";
const CODE_BUSY = "PAIRING_BUSY";
const CODE_INVALID = "PAIRING_CODE_INVALID";
const CODE_EXPIRED = "PAIRING_CODE_EXPIRED";
const CODE_IN_FLIGHT = "REGISTER_IN_FLIGHT";
const CODE_BRANCH_MISMATCH = "BRANCH_MISMATCH";
const CODE_REGISTER_CONFLICT_UNKNOWN = "REGISTER_CONFLICT";


const MSG_SERVER_BUSY = "Server busy, please try again.";
const MSG_CODE_INVALID =
  "This pairing code is expired or already used. Generate a new code in Tawla Settings \u2192 Print host on the web, then enter it again.";
/** v1.22/v1.23: never auto-retried; code is kept (budget exhausted → later 401 INVALID clears it). */
const MSG_BRANCH_MISMATCH =
  "This pairing code belongs to a different branch. Get a new QR code or pairing code from Tawla Settings \u2192 Print host on the web, then try again.";
const MSG_CONFLICT_UNKNOWN =
  "The server could not complete pairing right now. Please try again.";

/** Upper-cased code; parseAgentError's synthetic "HTTP_<status>" counts as no code. */
function normCode(code) {
  const c = code == null ? "" : String(code).trim().toUpperCase();
  return /^HTTP_\d+$/.test(c) ? "" : c;
}

/** Above this, the wait is not meaningful — show "try again later". */
const RATE_LIMIT_MAX_SECONDS = 86400;
/**
 * Minutes→hours switch. Minutes use N = round(s/60), so anything from 3570s
 * would round to "60 minutes"; switching to hours at 3570 guarantees the
 * minutes branch says at most "about 59 minutes" (3569s), and 3570–5399s
 * read "about 1 hour".
 */
const HOURS_FROM_SECONDS = 3570;

/**
 * Wait text (shared spec with Android). s = ceil(seconds) for the seconds branch.
 *   s < 60            → "N seconds" (1 → "second")
 *   60 ≤ s < 3570     → "about N minutes", N = max(1, round(s/60)), 1 → "minute"
 *   3570 ≤ s ≤ 86400  → "about N hours", N = max(1, round(s/3600)), 1 → "hour"
 *   s > 86400         → "Please try again later."
 *   non-finite, ≤ 0, text, missing → "wait a moment"
 */
function rateLimitedMessage(retryAfterSeconds) {
  const n =
    typeof retryAfterSeconds === "number"
      ? retryAfterSeconds
      : typeof retryAfterSeconds === "string" && retryAfterSeconds.trim() !== ""
        ? Number(retryAfterSeconds)
        : NaN;
  if (!Number.isFinite(n) || n <= 0) {
    return "Too many pairing attempts. Please wait a moment, then try again.";
  }
  if (n > RATE_LIMIT_MAX_SECONDS) {
    return "Too many pairing attempts. Please try again later.";
  }
  const s = Math.ceil(n);
  if (s < 60) {
    return `Too many pairing attempts. Please wait ${s} second${s === 1 ? "" : "s"}, then try again.`;
  }
  if (s < HOURS_FROM_SECONDS) {
    const m = Math.max(1, Math.round(s / 60));
    return `Too many pairing attempts. Please wait about ${m} minute${m === 1 ? "" : "s"}, then try again.`;
  }
  const h = Math.max(1, Math.round(s / 3600));
  return `Too many pairing attempts. Please wait about ${h} hour${h === 1 ? "" : "s"}, then try again.`;
}

/**
 * Body retry_after_seconds wins; else Retry-After header (ms → s, rounded up).
 * Android parity: the body value counts only if it is a JSON number (a string such
 * as "12" is ignored → header); finite and > 0; above a day it becomes 86401 ("later").
 */
function retryAfterSeconds(bodySeconds, headerMs) {
  if (typeof bodySeconds === "number" && Number.isFinite(bodySeconds) && bodySeconds > 0) {
    return bodySeconds > RATE_LIMIT_MAX_SECONDS ? RATE_LIMIT_MAX_SECONDS + 1 : Math.ceil(bodySeconds);
  }
  const h = Number(headerMs);
  if (headerMs != null && Number.isFinite(h) && h > 0) return Math.ceil(h / 1000);
  return null;
}

function isRateLimited(status, code) {
  return Number(status) === 429 || normCode(code) === CODE_RATE_LIMITED;
}

/**
 * v1.23: failures that spend the code's shared 5-failure budget. Never auto-retried
 * with the same code; only a user Retry/Connect (or a new code) sends it again.
 */
function isBudgetFailure(status, code) {
  const c = normCode(code);
  return (
    isBusy(status, c) ||
    c === CODE_BRANCH_MISMATCH ||
    (Number(status) === 409 && c === "PRINT_HOST_ALREADY_CONFIGURED")
  );
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
  // Same order as Android PairingErrorMapper.failureMessage:
  // in-flight → busy → rate-limited → branch mismatch → dead code.
  if (isBusy(status, code)) return { code: CODE_BUSY, message: MSG_SERVER_BUSY };
  if (isRateLimited(status, code)) {
    return {
      code: CODE_RATE_LIMITED,
      message: rateLimitedMessage(result.retryAfterSeconds),
      retryAfterSeconds: result.retryAfterSeconds != null ? result.retryAfterSeconds : null,
    };
  }
  if (code === CODE_BRANCH_MISMATCH) {
    return { code: CODE_BRANCH_MISMATCH, message: MSG_BRANCH_MISMATCH };
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
  RATE_LIMIT_MAX_SECONDS,
  HOURS_FROM_SECONDS,
  MSG_SERVER_BUSY,
  MSG_CODE_INVALID,
  MSG_CONFLICT_UNKNOWN,
  MSG_BRANCH_MISMATCH,
  CODE_BRANCH_MISMATCH,
  rateLimitedMessage,
  retryAfterSeconds,
  isRateLimited,
  isBusy,
  isBudgetFailure,
  isCodeRejected,
  shouldClearCode,
  friendlyRegisterError,
};
