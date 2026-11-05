/**
 * BE v1.32 (lockout13) printer field caps for printers/sync.
 * name/model/status_detail/ip_address/host/external_id: 255 code points;
 * status: online|offline|error (≤16). Manual host entry capped at 253 (DNS).
 * Truncation cuts at a grapheme boundary under the code-point budget (same
 * dual-cap pattern as device_label). Over-long external_id gets a stable
 * hash suffix. Names: strip ZW/BOM then blank→fallback (BE v1.33).
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
function truncateByCodePoints(raw, maxCodePoints) {
  const chars = Array.from(raw);
  return chars.length > maxCodePoints
    ? chars.slice(0, maxCodePoints).join("")
    : raw;
}

/**
 * Truncate to at most maxCodePoints, cutting back to a grapheme boundary when
 * Intl.Segmenter is available. Fallback: Array.from code-point cut (never
 * UTF-16 string.slice). R20D-L2: if a single grapheme exceeds the budget,
 * fall back to a code-point cut — never return "" for a non-empty input.
 * Non-strings → "".
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
      if (parts.length > 0) return parts.join("");
      // First grapheme alone is over budget — code-point cut, never empty.
      return truncateByCodePoints(raw, maxCodePoints);
    } catch (_) {
      /* fall through */
    }
  }
  return truncateByCodePoints(raw, maxCodePoints);
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

/**
 * Invisible / blank-making code points stripped for the blank check only
 * (R22D-L2 / L14-I5). Includes ZWJ/ZWNJ so a ZWJ-only name is blank, while a
 * real emoji name (visible bases + ZWJ) still passes and we send the original.
 */
const NAME_BLANK_STRIP_CPS = new Set([
  0x200b, // ZWSP
  0x200c, // ZWNJ
  0x200d, // ZWJ
  0x2060, // WJ
  0xfeff, // BOM
  0x00a0, // NBSP
]);

/**
 * Copy used only for the blank check: strip ZWSP/ZWNJ/ZWJ/WJ/BOM/NBSP, then
 * trim whitespace. Does not mutate the value we keep/send.
 */
function printerNameBlankCheck(raw) {
  if (raw == null) return "";
  return Array.from(String(raw))
    .filter((ch) => !NAME_BLANK_STRIP_CPS.has(ch.codePointAt(0)))
    .join("")
    .trim();
}

/**
 * If the blank-check copy is empty (no visible characters), return fallbackId.
 * Otherwise return the original with only end spaces trimmed — keep ZWJ in
 * real emoji sequences; do not collapse inner spaces.
 */
function resolvePrinterName(raw, fallbackId) {
  const fallback = fallbackId != null ? String(fallbackId) : "";
  if (raw == null) return fallback;
  const original = String(raw);
  if (printerNameBlankCheck(original) === "") return fallback;
  // Trim ordinary end spaces only — do not collapse "A  B", do not strip ZWJ.
  return original.replace(/^[ \t\r\n\f\v]+|[ \t\r\n\f\v]+$/g, "");
}

/** @deprecated blank-check form; prefer resolvePrinterName for stored values. */
function sanitizePrinterName(raw) {
  return printerNameBlankCheck(raw);
}

/** Known raw statuses → default status_detail when clamping to error (R22D-L1). */
const KNOWN_STATUS_DETAILS = {
  out_of_paper: "Out of paper",
  paper_out: "Out of paper",
  paperout: "Out of paper",
  outofpaper: "Out of paper",
};

/**
 * BE v1.33 status vocabulary (case-insensitive). Anything else → "error".
 * Still hard-capped at 16 code points as a guard.
 */
function capStatus(raw) {
  if (raw == null) return raw;
  return normalizeStatusFields(raw, null).status;
}

/**
 * Clamp status and resolve detail (R22D-L1 / R23D-M1 / R24D).
 * One rule: detail is only cleared/changed when the upsert includes `status`
 * or an explicit `status_detail` (null clears). Neither → leave untouched.
 * - opts.detailProvided: status_detail key present (null = clear).
 * - opts.statusProvided: status key present; online/offline clear only then.
 * - Known raw statuses → error + default detail when empty.
 * R24D-I1: no separate explicit-null branch (incoming null already clears).
 */
function normalizeStatusFields(status, statusDetail, opts = {}) {
  const detailProvided = opts.detailProvided === true;
  // R25D-L2: null/undefined status is never "provided" (avoids → error).
  const statusProvided = opts.statusProvided === true && status != null;
  const incoming =
    statusDetail != null && String(statusDetail).trim() !== ""
      ? String(statusDetail)
      : null;
  let detail = incoming;
  if (status == null) {
    // Not a real status value — caller keeps stored status; detail only if provided.
    return {
      status: null,
      status_detail: detailProvided ? detail : incoming,
    };
  }
  const lower = String(status).trim().toLowerCase();
  let next;
  if (lower === "online" || lower === "offline" || lower === "error") {
    next = lower;
  } else if (KNOWN_STATUS_DETAILS[lower]) {
    next = "error";
    if (!detail) detail = KNOWN_STATUS_DETAILS[lower];
  } else {
    next = "error";
  }
  // Clear stale detail on online/offline only when this upsert included status
  // and did not supply a fresh detail (explicit null already yields incoming null).
  if (
    statusProvided &&
    (next === "online" || next === "offline") &&
    !detailProvided
  ) {
    detail = null;
  }
  return {
    status: truncateAtGraphemeBoundary(next, PRINTER_STATUS_MAX),
    status_detail: detail,
  };
}

/**
 * Port for the wire / registry: integer number, or digit string
 * /^[1-9][0-9]{0,4}$/ at most 65535 (R22D-L3 / R23D-L1). Rejects booleans,
 * hex, floats, leading-zero pads ("009100"), padded strings.
 * L14-I4: empty / whitespace-only string → omitted (undefined); never 0.
 */
function sanitizePort(raw) {
  if (typeof raw === "number") {
    if (!Number.isInteger(raw) || raw < 1 || raw > 65535) return undefined;
    return raw;
  }
  if (typeof raw === "string") {
    // Empty or whitespace-only → omitted (keep stored; never send 0).
    if (raw.trim() === "") return undefined;
    if (!/^[1-9][0-9]{0,4}$/.test(raw)) return undefined;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 65535) return undefined;
    return n;
  }
  return undefined;
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
  if (out.name != null) {
    const fallback =
      out.external_id != null ? String(out.external_id) : "";
    out.name = truncateAtGraphemeBoundary(
      resolvePrinterName(out.name, fallback),
      PRINTER_FIELD_MAX
    );
  }
  if (out.model != null) out.model = capOptionalField(out.model);
  if (out.ip_address != null) out.ip_address = capOptionalField(out.ip_address);
  if (out.host != null) out.host = capOptionalField(out.host);
  if (out.status != null || out.status_detail != null) {
    const detailProvided = Object.prototype.hasOwnProperty.call(
      out,
      "status_detail"
    );
    const statusProvided = Object.prototype.hasOwnProperty.call(out, "status");
    const n = normalizeStatusFields(out.status, out.status_detail, {
      detailProvided,
      statusProvided,
    });
    out.status = n.status;
    out.status_detail =
      n.status_detail != null ? capOptionalField(n.status_detail) : null;
  }
  if ("port" in out) {
    const port = sanitizePort(out.port);
    if (port === undefined) delete out.port;
    else out.port = port;
  }
  return out;
}

function validateManualPrinterName(name) {
  const s = String(name == null ? "" : name);
  if (codePointLength(s) > PRINTER_FIELD_MAX) return NAME_TOO_LONG;
  return null;
}

/**
 * Gate for set-printer-mapping: reject over-long names before upsert/sync.
 * Returns a ready-to-return IPC failure object, or null when the name is OK.
 * Keeps the if(nameLenErr) return in one place so the if(false) mutant dies.
 */
function rejectMappingIfNameTooLong(name) {
  const nameLenErr = validateManualPrinterName(name);
  if (nameLenErr) {
    return { ok: false, error: nameLenErr, code: "FIELD_TOO_LONG" };
  }
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


/**
 * @returns {{ index: number, field: string, row: object|null, label: string }|null}
 */
function pickPrinterFromValidationError(error, payload) {
  const details = extractValidationFieldDetails(error);
  const re = /^printers\.(\d+)\.([A-Za-z0-9_]+)$/;
  for (const k of Object.keys(details || {})) {
    const m = k.match(re);
    if (!m) continue;
    const idx = Number(m[1]);
    const field = m[2];
    const list = Array.isArray(payload) ? payload : [];
    const row = list[idx] || null;
    const label =
      (row && row.name && String(row.name).trim()) ||
      (row && row.external_id && String(row.external_id).trim()) ||
      `printer #${idx + 1}`;
    return { index: idx, field, row, label };
  }
  return null;
}

function formatPrinterSyncValidationError(error, payload) {
  const hit = pickPrinterFromValidationError(error, payload);
  if (hit) {
    const fieldLabel = String(hit.field || "field").replace(/_/g, " ");
    return `Could not sync printer "${hit.label}": ${fieldLabel} was rejected (too long or invalid). Shorten it and try again.`;
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
  truncateByCodePoints,
  capExternalId,
  sanitizePrinterName,
  printerNameBlankCheck,
  resolvePrinterName,
  sanitizePort,
  capStatus,
  normalizeStatusFields,
  capOptionalField,
  capSyncPrinterRow,
  validateManualPrinterName,
  rejectMappingIfNameTooLong,
  validateManualPrinterHost,
  validateManualLanExternalId,
  formatPrinterSyncValidationError,
  pickPrinterFromValidationError,
};
