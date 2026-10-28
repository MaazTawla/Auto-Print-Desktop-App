/**
 * Local durable set of processed server job_ids to avoid double-print on redelivery.
 * Ack Rabbit only after print success or after server failure ack (caller responsibility).
 */

"use strict";

const fs = require("fs");
const path = require("path");

const DEFAULT_MAX = 2000;

function createProcessedJobsStore(opts = {}) {
  const filePath = opts.filePath;
  const maxEntries = opts.maxEntries != null ? Number(opts.maxEntries) : DEFAULT_MAX;
  /** @type {Map<string, number>} jobId -> processedAt ms */
  let map = new Map();

  function load() {
    if (!filePath) return;
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
      const entries = Array.isArray(raw.entries) ? raw.entries : [];
      map = new Map();
      for (const e of entries) {
        if (e && e.id != null) map.set(String(e.id), Number(e.at) || Date.now());
      }
    } catch {
      map = new Map();
    }
  }

  function persist() {
    if (!filePath) return;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const entries = [...map.entries()]
        .sort((a, b) => a[1] - b[1])
        .slice(-maxEntries)
        .map(([id, at]) => ({ id, at }));
      map = new Map(entries.map((e) => [e.id, e.at]));
      fs.writeFileSync(
        filePath,
        JSON.stringify({ entries }, null, 0),
        "utf8"
      );
    } catch (_) {}
  }

  if (filePath) load();

  function has(jobId) {
    if (jobId == null || String(jobId).trim() === "") return false;
    return map.has(String(jobId).trim());
  }

  function mark(jobId) {
    if (jobId == null || String(jobId).trim() === "") return false;
    const id = String(jobId).trim();
    map.set(id, Date.now());
    if (map.size > maxEntries) {
      const sorted = [...map.entries()].sort((a, b) => a[1] - b[1]);
      map = new Map(sorted.slice(-maxEntries));
    }
    persist();
    return true;
  }

  function size() {
    return map.size;
  }

  return { has, mark, size, load, persist, _map: map };
}

module.exports = { createProcessedJobsStore, DEFAULT_MAX };
