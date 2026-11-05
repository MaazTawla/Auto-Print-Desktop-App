/**
 * BE v1.32 (lockout13) printer field caps for printers/sync.
 * name/model/status_detail/ip_address/host/external_id: 255 code points;
 * status: 16. Manual host entry capped at 253 (DNS). Truncation cuts at a
 * grapheme boundary under the code-point budget (same dual-cap pattern as
 * device_label). Over-long external_id gets a stable hash suffix.
 */
"use strict";

const crypto = require("crypto");

const PRINTER_FIELD_MAX = 255;
const PRINTER_STATUS_MAX = 16;
/** Manual Host / IP entry (DNS FQDN limit); external_id still checked at 255. */
const MANUAL_HOST_MAX = 253;

const NAME_TOO_LONG =
  "Name must be at most 255 characters.";
const HOST_TOO_LONG =
  "Host / IP must be at most 253 characters.";
const EXTERNAL_ID_TOO_LONG =
  "That host and port make an external id over 255 characters. Shorten the host.";

function codePointLength(s) {
  return Array.from(String(s || "")).length;
}

/**
 * Truncate to at most maxCodePoints, cutting back to a grapheme boundary when
 * Intl.Segmenter is available. Fallback: Array.from code-point cut (never
 * UTF-16 string.slice). Non-strings → "".
 */
function truncateAtGraphemeBoundary(raw, maxCodePoints) {
  if (typeof raw !== "string") return "";
  if (!Number.isFinite(maxCodePoints) || maxCodePoints <= 0) return "";
  if (!raw) return "";
  if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
    try {
      const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
      const parts = [];
      let cps = 0;
      for (const { segment } of seg.segment(raw)) {
        const segCp = Array.from(segment).length;
        if (cps + segCp > maxCodePoints) break;
        parts.push(segment);
        cps += segCp;
      }
      return parts.join("");
    } catch (_) {
      /* fall through */
    }
  }
  const chars = Array.from(raw);
  return chars.length > maxCodePoints
    ? chars.slice(0, maxCodePoints).join("")
    : raw;
}

/**
 * Cap external_id at 255 code points. When over, keep a stable prefix and
 * append #<12-hex sha256 of the original> so the same long id always maps
 * the same way and stays within the budget.
 */
function capExternalId(raw, maxCodePoints = PRINTER_FIELD_MAX) {
  const s = String(raw == null ? "" : raw);
  if (!s) return s;
  if (codePointLength(s) <= maxCodePoints) return s;
  const hash = crypto.createHash("sha256").update(s, "utf8").digest("hex").slice(0, 12);
  const suffix = "#" + hash;
  const budget = Math.max(0, maxCodePoints - codePointLength(suffix));
  return truncateAtGraphemeBoundary(s, budget) + suffix;
}

function capStatus(raw) {
  if (raw == null) return raw;
  const s = String(raw);
  // Keep known vocabulary short; still hard-cap at 16 as a guard.
  const mapped = s === "out_of_paper" ? "error" : s;
  return truncateAtGraphemeBoundary(mapped, PRINTER_STATUS_MAX);
}

function capOptionalField(raw, max = PRINTER_FIELD_MAX) {
  if (raw == null) return raw;
  return truncateAtGraphemeBoundary(String(raw), max);
}

/**
 * Cap a printers/sync (or status) row for the wire. Does not mutate the
 * local registry — only the outbound payload.
 */
function capSyncPrinterRow(row) {
  if (!row || typeof row !== "object") return row;
  const out = { ...row };
  if (out.external_id != null) out.external_id = capExternalId(out.external_id);
  if (out.name != null) out.name = truncateAtGraphemeBoundary(String(out.name), PRINTER_FIELD_MAX);
  if (out.model != null) out.model = capOptionalField(out.model);
  if (out.status_detail != null) out.status_detail = capOptionalField(out.status_detail);
  if (out.ip_address != null) out.ip_address = capOptionalField(out.ip_address);
  if (out.host != null) out.host = capOptionalField(out.host);
  if (out.status != null) out.status = capStatus(out.status);
  return out;
}

function validateManualPrinterName(name) {
  const s = String(name == null ? "" : name);
  if (codePointLength(s) > PRINTER_FIELD_MAX) return NAME_TOO_LONG;
  return null;
}

function validateManualPrinterHost(host) {
  const s = String(host == null ? "" : host).trim();
  if (codePointLength(s) > MANUAL_HOST_MAX) return HOST_TOO_LONG;
  return null;
}

/**
 * Reject before save when the derived lan:host:port external_id would exceed
 * 255 even after hash-cap is available — prefer telling the user to shorten
 * the host rather than silently hashing a manually entered id.
 * Returns null when OK, else an error string.
 */
function validateManualLanExternalId(host, port) {
  const h = String(host == null ? "" : host).trim();
  const p = port == null ? "" : String(port);
  const eid = `lan:${h}:${p}`;
  if (codePointLength(eid) > PRINTER_FIELD_MAX) return EXTERNAL_ID_TOO_LONG;
  return null;
}

/**
 * Turn a 422 VALIDATION_ERROR details map into a message that names the
 * printer. details keys look like "printers.1.name".
 * @param {object} error parseAgentError-shaped
 * @param {Array<object>} payload printers sent in the sync
 */
function extractValidationFieldDetails(error) {
  if (!error || typeof error !== "object") return {};
  const candidates = [];
  if (error.details && typeof error.details === "object" && !Array.isArray(error.details)) {
    candidates.push(error.details);
    if (
      error.details.details &&
      typeof error.details.details === "object" &&
      !Array.isArray(error.details.details)
    ) {
      candidates.push(error.details.details);
    }
  }
  for (const c of candidates) {
    const keys = Object.keys(c);
    if (keys.some((k) => /^printers\.\d+\./.test(k))) return c;
  }
  return candidates[0] || {};
}

function formatPrinterSyncValidationError(error, payload) {
  const details = extractValidationFieldDetails(error);
  const keys = Object.keys(details);
  const re = /^printers\.(\d+)\.([A-Za-z0-9_]+)$/;
  let best = null;
  for (const k of keys) {
    const m = k.match(re);
    if (!m) continue;
    const idx = Number(m[1]);
    const field = m[2];
    if (!Number.isInteger(idx) || idx < 0) continue;
    best = { idx, field, key: k };
    break;
  }
  const list = Array.isArray(payload) ? payload : [];
  if (best && list[best.idx]) {
    const row = list[best.idx];
    const label =
      (row.name && String(row.name).trim()) ||
      (row.external_id && String(row.external_id).trim()) ||
      `printer #${best.idx + 1}`;
    const fieldLabel = best.field.replace(/_/g, " ");
    return `Could not sync printer "${label}": ${fieldLabel} was rejected (too long or invalid). Shorten it and try again.`;
  }
  const base =
    (error && error.message) ||
    (error && typeof error === "string" ? error : null) ||
    "Printer sync failed (validation error).";
  return String(base);
}

module.exports = {
  PRINTER_FIELD_MAX,
  PRINTER_STATUS_MAX,
  MANUAL_HOST_MAX,
  NAME_TOO_LONG,
  HOST_TOO_LONG,
  EXTERNAL_ID_TOO_LONG,
  codePointLength,
  truncateAtGraphemeBoundary,
  capExternalId,
  capStatus,
  capOptionalField,
  capSyncPrinterRow,
  validateManualPrinterName,
  validateManualPrinterHost,
  validateManualLanExternalId,
  formatPrinterSyncValidationError,
};
