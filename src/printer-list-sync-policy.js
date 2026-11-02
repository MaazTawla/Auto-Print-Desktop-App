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

module.exports = {
  configHash,
  statusFingerprint,
  shouldSkipUnchanged,
  shouldLogHeartbeatFailure,
};
