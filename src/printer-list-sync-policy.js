"use strict";

const crypto = require("crypto");

/**
 * Config (printer-list) sync dedupe — identity/config fields only.
 * Status changes use the dedicated printer status endpoint.
 */
function configHash(payloads) {
  const list = Array.isArray(payloads) ? payloads.slice() : [];
  list.sort((a, b) =>
    String(a.external_id || "").localeCompare(String(b.external_id || ""), undefined, {
      sensitivity: "base",
    })
  );
  const lines = list.map((p) =>
    [
      String(p.external_id || "").trim().toLowerCase(),
      String(p.name || "").trim(),
      String(p.connection_type || p.connection || "").trim().toLowerCase(),
      String(p.ip_address || "").trim(),
      p.port != null ? String(p.port) : "",
      String(p.model || "").trim(),
      // Match toSyncPayload: default flag must invalidate the list-sync hash (M2).
      p.is_default || p.isDefault ? "1" : "0",
    ].join("\u0001")
  );
  return crypto.createHash("sha256").update(lines.join("\n"), "utf8").digest("hex");
}

function statusFingerprint(payloads) {
  const list = Array.isArray(payloads) ? payloads.slice() : [];
  list.sort((a, b) =>
    String(a.external_id || "").localeCompare(String(b.external_id || ""), undefined, {
      sensitivity: "base",
    })
  );
  const lines = list.map((p) =>
    [
      String(p.external_id || "").trim().toLowerCase(),
      String(p.status || "").trim().toLowerCase(),
      String(p.status_detail || "").trim(),
    ].join("\u0001")
  );
  return crypto.createHash("sha256").update(lines.join("\n"), "utf8").digest("hex");
}

function shouldSkipUnchanged(hash, lastSuccessfulHash, { forceEmpty = false, pendingEmpty = false } = {}) {
  if (forceEmpty || pendingEmpty) return false;
  const last = lastSuccessfulHash != null ? String(lastSuccessfulHash).trim() : "";
  if (!last) return false;
  return String(hash) === last;
}

function shouldLogHeartbeatFailure(consecutiveFailures, everyNth = 3) {
  const n = Number(consecutiveFailures) || 0;
  if (n <= 0) return false;
  if (n === 1) return true;
  return n % everyNth === 0;
}

/**
 * Accelerated heartbeat retry after a failed liveness ping.
 * Matches Android: min(5s * consecutiveFailures, 20s) so recovery stays
 * well inside the 90s offline TTL (L1).
 */
function heartbeatFailureRetryMs(consecutiveFailures) {
  const n = Math.max(1, Number(consecutiveFailures) || 1);
  return Math.min(5_000 * n, 20_000);
}

module.exports = {
  configHash,
  statusFingerprint,
  shouldSkipUnchanged,
  shouldLogHeartbeatFailure,
  heartbeatFailureRetryMs,
};
