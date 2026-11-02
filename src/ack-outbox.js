/**
 * Durable outbox for server job acks (printed / failed).
 * Mark job processed first (caller), enqueue here, Rabbit-ack after durable write.
 * Flush with jittered backoff until 2xx, terminal 4xx (every 4xx except 408/429),
 * or the retry budget (MAX_ATTEMPTS / MAX_AGE_MS) is exhausted. Exhausted entries
 * are dead-lettered (ack-outbox.dead.json for Maintenance) and removed so they
 * release their outbox slot. Server ack is idempotent per job_id.
 *
 * Corrupt outbox JSON: quarantine to outbox.corrupt-<ts>.json, surface warning,
 * start a fresh empty outbox — never silently drop without a trace.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const {
  isTerminal: httpIsTerminal,
  isSuccess: httpIsSuccess,
  delayMs: httpDelayMs,
  parseRetryAfterMs,
} = require("./agent-http-retry-policy");

const DEFAULT_MAX = 2000;
const DEFAULT_CORRUPT_KEEP = 10;
const BACKOFF_MS = [1000, 5000, 15000, 30000, 60000, 120000];
/** Cap retryable ACK failures (5xx / 401 / 403 / 408 / 429 / network). ~30 ≈ under an hour. */
const MAX_ATTEMPTS = 30;
/** Absolute age ceiling so skipped_no_token cannot loop forever. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DEAD_LETTER_KEEP = 50;
const DEAD_LETTER_NAME = "ack-outbox.dead.json";
const CORRUPT_NAME_RE = /^outbox\.corrupt-(\d+)\.json$/;

function isTerminalAckStatus(status) {
  if (status == null || !Number.isFinite(Number(status))) return false;
  const s = Number(status);
  if (s >= 200 && s < 300) return true; // success also terminal for remove
  return httpIsTerminal(s);
}

function isSuccessAckStatus(status) {
  return httpIsSuccess(status);
}

function nextBackoffMs(attempts, jitter01 = 0.5) {
  const i = Math.min(Math.max(0, attempts - 1), BACKOFF_MS.length - 1);
  const base = BACKOFF_MS[i];
  const j = Math.min(1, Math.max(0, Number(jitter01)));
  // ±20% jitter around the base delay.
  const factor = 0.8 + 0.4 * (Number.isFinite(j) ? j : 0.5);
  return Math.max(1, Math.round(base * factor));
}

function isRetryBudgetExhausted(
  attempts,
  createdAtMs,
  nowMs = Date.now(),
  maxAttempts = MAX_ATTEMPTS,
  maxAgeMs = MAX_AGE_MS
) {
  if ((Number(attempts) || 0) >= maxAttempts) return true;
  const created = Number(createdAtMs) || 0;
  if (created > 0 && nowMs - created >= maxAgeMs) return true;
  return false;
}

/** Log first failure, then every Nth — avoids flood on persistent 5xx. */
function shouldLogRetryFailure(attempts, everyNth = 5) {
  const a = Number(attempts) || 0;
  if (a <= 0) return false;
  if (a === 1) return true;
  return a % everyNth === 0;
}


/**
 * Keep the newest `keep` outbox.corrupt-* files in dir; delete older ones (QA r4 L).
 */
function pruneCorruptQuarantines(dir, keep = DEFAULT_CORRUPT_KEEP) {
  if (!dir) return { kept: 0, deleted: [] };
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => CORRUPT_NAME_RE.test(n));
  } catch {
    return { kept: 0, deleted: [] };
  }
  names.sort((a, b) => {
    const ta = Number((a.match(CORRUPT_NAME_RE) || [])[1]) || 0;
    const tb = Number((b.match(CORRUPT_NAME_RE) || [])[1]) || 0;
    return tb - ta; // newest first
  });
  const limit = Math.max(0, Number(keep) || DEFAULT_CORRUPT_KEEP);
  const deleted = [];
  for (const name of names.slice(limit)) {
    const full = path.join(dir, name);
    try {
      fs.unlinkSync(full);
      deleted.push(full);
    } catch (_) {}
  }
  return { kept: Math.min(names.length, limit), deleted };
}

function createAckOutbox(opts = {}) {
  const filePath = opts.filePath;
  const maxEntries = opts.maxEntries != null ? Number(opts.maxEntries) : DEFAULT_MAX;
  const deadLetterKeep =
    opts.deadLetterKeep != null ? Number(opts.deadLetterKeep) : DEFAULT_DEAD_LETTER_KEEP;
  const onCorrupt = typeof opts.onCorrupt === "function" ? opts.onCorrupt : null;
  /** @type {Map<string, object>} keyed by jobId (one pending ack per job) */
  let map = new Map();
  /** @type {null | { quarantinedPath: string, at: string, error: string }} */
  let corruptInfo = null;

  function quarantineCorrupt(err) {
    if (!filePath) return null;
    const ts = Date.now();
    const quarantinedPath = path.join(path.dirname(filePath), `outbox.corrupt-${ts}.json`);
    try {
      if (fs.existsSync(filePath)) {
        fs.renameSync(filePath, quarantinedPath);
      }
    } catch (renameErr) {
      // If rename fails, try copy+unlink so we still clear the bad file
      try {
        if (fs.existsSync(filePath)) {
          fs.copyFileSync(filePath, quarantinedPath);
          fs.unlinkSync(filePath);
        }
      } catch (_) {
        return {
          quarantinedPath: filePath,
          at: new Date().toISOString(),
          error: `${err && err.message ? err.message : String(err)}; quarantine failed: ${renameErr.message || renameErr}`,
        };
      }
    }
    const info = {
      quarantinedPath,
      at: new Date().toISOString(),
      error: err && err.message ? String(err.message) : String(err),
    };
    try {
      pruneCorruptQuarantines(path.dirname(filePath), opts.corruptKeep != null ? opts.corruptKeep : DEFAULT_CORRUPT_KEEP);
    } catch (_) {}
    return info;
  }

  function load() {
    if (!filePath) return;
    if (!fs.existsSync(filePath)) {
      map = new Map();
      return;
    }
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
      const entries = Array.isArray(raw.entries) ? raw.entries : [];
      map = new Map();
      for (const e of entries) {
        if (e && e.jobId != null) map.set(String(e.jobId), normalize(e));
      }
    } catch (err) {
      map = new Map();
      corruptInfo = quarantineCorrupt(err);
      if (corruptInfo && onCorrupt) {
        try {
          onCorrupt(corruptInfo);
        } catch (_) {}
      }
      // Fresh outbox file on next persist; leave missing until enqueue
    }
  }

  function normalize(e) {
    return {
      id: e.id || `${e.jobId}:${e.status || "failed"}`,
      jobId: String(e.jobId),
      status: e.status === "printed" ? "printed" : "failed",
      reason: e.reason != null ? String(e.reason) : null,
      printerExternalId:
        e.printerExternalId != null ? String(e.printerExternalId) : null,
      attempts: Number(e.attempts) || 0,
      nextAttemptAt: Number(e.nextAttemptAt) || 0,
      createdAt: Number(e.createdAt) || Date.now(),
      lastError: e.lastError != null ? String(e.lastError) : null,
      lastStatus: e.lastStatus != null ? Number(e.lastStatus) : null,
    };
  }

  function persist() {
    if (!filePath) return;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      let entries = [...map.values()].sort((a, b) => a.createdAt - b.createdAt);
      if (entries.length > maxEntries) entries = entries.slice(-maxEntries);
      map = new Map(entries.map((e) => [e.jobId, e]));
      fs.writeFileSync(
        filePath,
        JSON.stringify({ entries }, null, 0),
        "utf8"
      );
    } catch (_) {}
  }

  if (filePath) load();

  /**
   * Enqueue (or replace) a server ack. Durable before return.
   */
  function enqueue({ jobId, status, reason, printerExternalId }) {
    if (jobId == null || String(jobId).trim() === "") return null;
    const id = String(jobId).trim();
    const entry = normalize({
      id: `${id}:${status === "printed" ? "printed" : "failed"}`,
      jobId: id,
      status: status === "printed" ? "printed" : "failed",
      reason: reason || null,
      printerExternalId: printerExternalId || null,
      attempts: 0,
      nextAttemptAt: 0,
      createdAt: Date.now(),
    });
    map.set(id, entry);
    persist();
    return entry;
  }

  function has(jobId) {
    if (jobId == null) return false;
    return map.has(String(jobId).trim());
  }

  function get(jobId) {
    if (jobId == null) return null;
    return map.get(String(jobId).trim()) || null;
  }

  function remove(jobId) {
    if (jobId == null) return false;
    const ok = map.delete(String(jobId).trim());
    if (ok) persist();
    return ok;
  }

  function listDue(now = Date.now()) {
    return [...map.values()]
      .filter((e) => (e.nextAttemptAt || 0) <= now)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  function listAll() {
    return [...map.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  function deadLetterPath() {
    if (!filePath) return null;
    return path.join(path.dirname(filePath), DEAD_LETTER_NAME);
  }

  function loadDeadLetters() {
    const p = deadLetterPath();
    if (!p || !fs.existsSync(p)) return [];
    try {
      const raw = JSON.parse(fs.readFileSync(p, "utf8"));
      return Array.isArray(raw.entries) ? raw.entries : [];
    } catch {
      return [];
    }
  }

  function appendDeadLetter(entry, cause, nowMs) {
    const p = deadLetterPath();
    if (!p) return false;
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const existing = loadDeadLetters();
      existing.push({
        jobId: entry.jobId,
        status: entry.status,
        reason: entry.reason != null ? entry.reason : null,
        printerExternalId: entry.printerExternalId != null ? entry.printerExternalId : null,
        attempts: entry.attempts || 0,
        lastStatus: entry.lastStatus != null ? entry.lastStatus : null,
        lastError: entry.lastError != null ? entry.lastError : null,
        createdAt: entry.createdAt || 0,
        deadLetteredAt: nowMs,
        cause: cause || "RETRY_BUDGET",
      });
      const keep = Math.max(1, deadLetterKeep || DEFAULT_DEAD_LETTER_KEEP);
      const trimmed = existing.slice(-keep);
      fs.writeFileSync(p, JSON.stringify({ entries: trimmed }, null, 0), "utf8");
      return true;
    } catch {
      return false;
    }
  }

  function listDeadLetters() {
    return loadDeadLetters();
  }

  function markAttempt(jobId, { ok, status, error, nowMs, jitter01, retryAfterMs } = {}) {
    const id = String(jobId).trim();
    const entry = map.get(id);
    if (!entry) return null;
    const now = nowMs != null ? Number(nowMs) : Date.now();
    if (ok || isSuccessAckStatus(status) || isTerminalAckStatus(status)) {
      map.delete(id);
      persist();
      return {
        removed: true,
        entry,
        terminal: true,
        ok: Boolean(ok || isSuccessAckStatus(status)),
        exhausted: false,
        deadLettered: false,
      };
    }
    entry.attempts = (entry.attempts || 0) + 1;
    entry.lastStatus = status != null ? Number(status) : null;
    entry.lastError = error != null ? String(error) : null;
    const j = jitter01 != null ? jitter01 : Math.random();
    const delay = httpDelayMs(entry.attempts, {
      jitter01: j,
      retryAfterMs: retryAfterMs != null ? Number(retryAfterMs) : null,
      backoffMs: nextBackoffMs,
    });
    entry.nextAttemptAt = now + delay;
    if (isRetryBudgetExhausted(entry.attempts, entry.createdAt, now)) {
      const cause =
        entry.attempts >= MAX_ATTEMPTS ? "MAX_ATTEMPTS" : "MAX_AGE";
      const wrote = appendDeadLetter(entry, cause, now);
      map.delete(id);
      persist();
      return {
        removed: true,
        entry,
        terminal: true,
        ok: false,
        exhausted: true,
        deadLettered: Boolean(wrote || true),
      };
    }
    map.set(id, entry);
    persist();
    return { removed: false, entry, terminal: false, ok: false, exhausted: false, deadLettered: false };
  }

  function size() {
    return map.size;
  }

  function getCorruptInfo() {
    return corruptInfo;
  }

  function clearCorruptInfo() {
    corruptInfo = null;
  }

  return {
    enqueue,
    has,
    get,
    remove,
    listDue,
    listAll,
    markAttempt,
    size,
    load,
    persist,
    getCorruptInfo,
    clearCorruptInfo,
    BACKOFF_MS,
    MAX_ATTEMPTS,
    MAX_AGE_MS,
    listDeadLetters,
    deadLetterPath,
  };
}

module.exports = {
  createAckOutbox,
  pruneCorruptQuarantines,
  isTerminalAckStatus,
  isSuccessAckStatus,
  nextBackoffMs,
  isRetryBudgetExhausted,
  shouldLogRetryFailure,
  parseRetryAfterMs,
  BACKOFF_MS,
  MAX_ATTEMPTS,
  MAX_AGE_MS,
  DEFAULT_MAX,
  DEFAULT_CORRUPT_KEEP,
  DEFAULT_DEAD_LETTER_KEEP,
  DEAD_LETTER_NAME,
};
