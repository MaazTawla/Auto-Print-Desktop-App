/**
 * Durable outbox for server job acks (printed / failed).
 * Mark job processed first (caller), enqueue here, Rabbit-ack after durable write.
 * Flush with backoff until 2xx or terminal 4xx. Server ack is idempotent per job_id.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const DEFAULT_MAX = 2000;
const BACKOFF_MS = [1000, 5000, 15000, 30000, 60000, 120000];

function isTerminalAckStatus(status) {
  if (status == null || !Number.isFinite(Number(status))) return false;
  const s = Number(status);
  if (s >= 200 && s < 300) return true; // success also terminal for remove
  if (s === 408 || s === 429) return false;
  if (s === 401 || s === 403) return false; // retry after re-pair
  if (s >= 400 && s < 500) return true;
  return false;
}

function isSuccessAckStatus(status) {
  const s = Number(status);
  return Number.isFinite(s) && s >= 200 && s < 300;
}

function nextBackoffMs(attempts) {
  const i = Math.min(Math.max(0, attempts - 1), BACKOFF_MS.length - 1);
  return BACKOFF_MS[i];
}

function createAckOutbox(opts = {}) {
  const filePath = opts.filePath;
  const maxEntries = opts.maxEntries != null ? Number(opts.maxEntries) : DEFAULT_MAX;
  /** @type {Map<string, object>} keyed by jobId (one pending ack per job) */
  let map = new Map();

  function load() {
    if (!filePath) return;
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
      const entries = Array.isArray(raw.entries) ? raw.entries : [];
      map = new Map();
      for (const e of entries) {
        if (e && e.jobId != null) map.set(String(e.jobId), normalize(e));
      }
    } catch {
      map = new Map();
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

  function markAttempt(jobId, { ok, status, error }) {
    const id = String(jobId).trim();
    const entry = map.get(id);
    if (!entry) return null;
    if (ok || isSuccessAckStatus(status) || isTerminalAckStatus(status)) {
      map.delete(id);
      persist();
      return { removed: true, entry, terminal: true, ok: Boolean(ok || isSuccessAckStatus(status)) };
    }
    entry.attempts = (entry.attempts || 0) + 1;
    entry.lastStatus = status != null ? Number(status) : null;
    entry.lastError = error != null ? String(error) : null;
    entry.nextAttemptAt = Date.now() + nextBackoffMs(entry.attempts);
    map.set(id, entry);
    persist();
    return { removed: false, entry, terminal: false, ok: false };
  }

  function size() {
    return map.size;
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
    BACKOFF_MS,
  };
}

module.exports = {
  createAckOutbox,
  isTerminalAckStatus,
  isSuccessAckStatus,
  nextBackoffMs,
  BACKOFF_MS,
  DEFAULT_MAX,
};
