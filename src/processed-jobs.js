/**
 * Local durable job_id ledger:
 * - "printing": set before spooling so a crash mid-print cannot double-print on redelivery
 * - "processed": set after success/fail finalize (never print again)
 *
 * Redelivery with printing (not processed) → fail-ack PRINT_INTERRUPTED (caller).
 */

"use strict";

const fs = require("fs");
const path = require("path");

const DEFAULT_MAX = 2000;
const STATUS_PRINTING = "printing";
const STATUS_PROCESSED = "processed";

function createProcessedJobsStore(opts = {}) {
  const filePath = opts.filePath;
  const maxEntries = opts.maxEntries != null ? Number(opts.maxEntries) : DEFAULT_MAX;
  /** @type {Map<string, { status: string, at: number }>} */
  let map = new Map();

  function load() {
    if (!filePath) return;
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
      const entries = Array.isArray(raw.entries) ? raw.entries : [];
      map = new Map();
      for (const e of entries) {
        if (!e || e.id == null) continue;
        const id = String(e.id);
        // Legacy rows had only { id, at } — treat as processed
        const status =
          e.status === STATUS_PRINTING ? STATUS_PRINTING : STATUS_PROCESSED;
        map.set(id, { status, at: Number(e.at) || Date.now() });
      }
    } catch {
      map = new Map();
    }
  }

  function trim() {
    if (map.size <= maxEntries) return;
    const entries = [...map.entries()].map(([id, v]) => ({
      id,
      status: v.status,
      at: v.at,
    }));
    entries.sort((a, b) => a.at - b.at);
    // Prefer dropping oldest processed; keep printing markers when possible
    const printing = entries.filter((e) => e.status === STATUS_PRINTING);
    const processed = entries.filter((e) => e.status !== STATUS_PRINTING);
    const keep = [];
    const roomForProcessed = Math.max(0, maxEntries - printing.length);
    keep.push(...processed.slice(-roomForProcessed));
    const roomLeft = maxEntries - keep.length;
    if (roomLeft > 0) keep.push(...printing.slice(-roomLeft));
    // If still over (more printing than max), drop oldest printing
    keep.sort((a, b) => a.at - b.at);
    map = new Map(
      keep.slice(-maxEntries).map((e) => [e.id, { status: e.status, at: e.at }])
    );
  }

  function persist() {
    trim();
    if (!filePath) return;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const entries = [...map.entries()].map(([id, v]) => ({
        id,
        status: v.status,
        at: v.at,
      }));
      entries.sort((a, b) => a.at - b.at);
      fs.writeFileSync(
        filePath,
        JSON.stringify({ entries }, null, 0),
        "utf8"
      );
    } catch (_) {}
  }

  if (filePath) load();

  function get(jobId) {
    if (jobId == null || String(jobId).trim() === "") return null;
    return map.get(String(jobId).trim()) || null;
  }

  /** True when job was fully processed (printed or fail-acked). */
  function has(jobId) {
    const row = get(jobId);
    return Boolean(row && row.status === STATUS_PROCESSED);
  }

  /** True when a print was started but not yet finalized (crash window). */
  function isPrinting(jobId) {
    const row = get(jobId);
    return Boolean(row && row.status === STATUS_PRINTING);
  }

  /**
   * Durable "about to print / printing" marker. No-op if already processed.
   */
  function markPrinting(jobId) {
    if (jobId == null || String(jobId).trim() === "") return false;
    const id = String(jobId).trim();
    const prev = map.get(id);
    if (prev && prev.status === STATUS_PROCESSED) return false;
    map.set(id, { status: STATUS_PRINTING, at: Date.now() });
    persist();
    return true;
  }

  /** Mark fully processed (clears printing). */
  function mark(jobId) {
    if (jobId == null || String(jobId).trim() === "") return false;
    const id = String(jobId).trim();
    map.set(id, { status: STATUS_PROCESSED, at: Date.now() });
    persist();
    return true;
  }

  function size() {
    return map.size;
  }

  function printingCount() {
    let n = 0;
    for (const v of map.values()) {
      if (v.status === STATUS_PRINTING) n += 1;
    }
    return n;
  }

  return {
    has,
    isPrinting,
    markPrinting,
    mark,
    get,
    size,
    printingCount,
    load,
    persist,
    STATUS_PRINTING,
    STATUS_PROCESSED,
  };
}

module.exports = {
  createProcessedJobsStore,
  DEFAULT_MAX,
  STATUS_PRINTING,
  STATUS_PROCESSED,
};
