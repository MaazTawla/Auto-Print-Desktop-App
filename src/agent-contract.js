/**
 * Print-agent API contract (station printing Option A).
 * Aligned to Backend contract v1.0:
 * /workspace/station-printing-web/docs/printing/station-printing-contract.md
 *
 * Base path: /api/v1/print-agent
 * Agent success bodies are flat JSON at the root.
 */

"use strict";

const PLATFORM = "desktop";

const ERROR_CODES = Object.freeze({
  PRINT_HOST_ALREADY_CONFIGURED: "PRINT_HOST_ALREADY_CONFIGURED",
  PAIRING_CODE_INVALID: "PAIRING_CODE_INVALID",
  PAIRING_CODE_EXPIRED: "PAIRING_CODE_EXPIRED",
  NOT_PRINT_HOST: "NOT_PRINT_HOST",
  HOST_EPOCH_MISMATCH: "HOST_EPOCH_MISMATCH",
  BRANCH_MISMATCH: "BRANCH_MISMATCH",
});

/** Relative paths under /api/v1/print-agent */
const ENDPOINTS = Object.freeze({
  register: "/register",
  heartbeat: "/heartbeat",
  deregister: "/deregister",
  printersSync: "/printers/sync",
  jobAck: (jobId) => `/jobs/${encodeURIComponent(String(jobId))}/ack`,
  printerStatus: (printerId) =>
    `/printers/${encodeURIComponent(String(printerId))}/status`,
});

/**
 * Contract v1.0 — confirmed (was ASSUMPTIONS; kept name for call sites).
 * Remaining gaps (non-blocking) listed in REMAINING_GAPS.
 */
const ASSUMPTIONS = Object.freeze({
  contractVersion: "1.0",
  apiBasePath: "/api/v1/print-agent",
  /** Client heartbeat interval — server advertises heartbeat_interval_seconds: 30 */
  heartbeatIntervalMs: 30000,
  /** Server marks host offline after this many ms without heartbeat */
  heartbeatTtlMs: 90000,
  registerRole: "print_host",
  /** pairing_code + role are required on register; no server auto-claim */
  pairingCodeRequired: true,
  deviceLabelRequired: true,
  /** Success token field is `token` (flat root). Envelope data.token still tolerated. */
  tokenField: "token",
  agentResponsesFlat: true,
  rabbitSingleActiveConsumer: true,
  /** Agents keep active declare with identical SAC args; never exclusive=true */
  consumeExclusive: false,
  prefetch: 1,
  messageSchemaVersion: 2,
  /** Default PDF delivery is pdf_url; pdf_base64 is opt-in on server */
  pdfDelivery: "url_or_base64",
  /** printers/sync keyed by external_id; server assigns numeric id */
  printersSyncKey: "external_id",
  printersServerAssignsId: true,
});

/** Open / deferred items from contract §11 that Desktop does not fully own. */
const REMAINING_GAPS = Object.freeze([
  "Optional apply of register.rabbit credentials into local Rabbit settings (fields present; UI/ops may still configure manually).",
  "pdf_sha256 verification on download is best-effort; failure still attempts print with a warning.",
  "Deregister clears branch host on server — product confirmation is with Work Planner, not Desktop.",
]);

function buildRegisterRequest({
  appId,
  branchId,
  platform = PLATFORM,
  deviceLabel,
  pairingCode,
  role = ASSUMPTIONS.registerRole,
  agentVersion,
}) {
  const code = pairingCode != null ? String(pairingCode).trim() : "";
  const label = deviceLabel != null ? String(deviceLabel).trim() : "";
  if (!code) {
    const err = new Error("pairing_code is required");
    err.code = "VALIDATION_ERROR";
    throw err;
  }
  if (!label) {
    const err = new Error("device_label is required");
    err.code = "VALIDATION_ERROR";
    throw err;
  }
  const body = {
    pairing_code: code,
    app_id: String(appId || "").trim(),
    platform,
    device_label: label,
    role: role || ASSUMPTIONS.registerRole,
  };
  if (branchId != null && String(branchId).trim() !== "") {
    body.branch_id = String(branchId).trim();
  }
  if (agentVersion != null && String(agentVersion).trim() !== "") {
    body.agent_version = String(agentVersion).trim();
  }
  return body;
}

/**
 * Flat agent success body. Tolerates legacy `{ data: { token } }` envelope only.
 * Does not read access_token.
 */
function parseRegisterResponse(data) {
  if (!data || typeof data !== "object") {
    return { ok: false, error: { code: "BAD_RESPONSE", message: "Empty register response" } };
  }
  const src =
    data.token == null && data.data && typeof data.data === "object" && data.data.token != null
      ? data.data
      : data;
  const token = src.token != null ? String(src.token) : "";
  const isPrintHost = Boolean(src.is_print_host ?? src.isPrintHost);
  const hostEpoch = Number(src.host_epoch ?? src.hostEpoch ?? 1);
  return {
    ok: true,
    token,
    token_type: src.token_type != null ? String(src.token_type) : "Bearer",
    is_print_host: isPrintHost,
    host_epoch: Number.isFinite(hostEpoch) ? hostEpoch : 1,
    app_id: src.app_id != null ? String(src.app_id) : null,
    branch_id: src.branch_id != null ? src.branch_id : null,
    heartbeat_interval_seconds: Number(src.heartbeat_interval_seconds) || 30,
    heartbeat_ttl_seconds: Number(src.heartbeat_ttl_seconds) || 90,
    station_printing_enabled: src.station_printing_enabled,
    rabbit: src.rabbit && typeof src.rabbit === "object" ? src.rabbit : null,
    raw: data,
  };
}

/**
 * Parse 409 PRINT_HOST_ALREADY_CONFIGURED (contract §2.1).
 */
function parseHostConflictError(payload, httpStatus) {
  const root = payload && typeof payload === "object" ? payload : {};
  const err = root.error && typeof root.error === "object" ? root.error : root;
  const code = err.code != null ? String(err.code) : "";
  const isConflict =
    httpStatus === 409 || code === ERROR_CODES.PRINT_HOST_ALREADY_CONFIGURED;
  if (!isConflict) return null;

  const current = err.current_host || err.currentHost || null;
  return {
    code: ERROR_CODES.PRINT_HOST_ALREADY_CONFIGURED,
    message:
      (err.message != null && String(err.message).trim()) ||
      "Another device is already configured as print host for this branch.",
    current_host: current
      ? {
          app_id: current.app_id != null ? String(current.app_id) : "",
          device_label:
            current.device_label != null
              ? String(current.device_label)
              : current.deviceLabel != null
                ? String(current.deviceLabel)
                : "",
          last_heartbeat_at:
            current.last_heartbeat_at != null
              ? String(current.last_heartbeat_at)
              : current.lastHeartbeatAt != null
                ? String(current.lastHeartbeatAt)
                : null,
          is_online: Boolean(current.is_online ?? current.isOnline ?? false),
        }
      : null,
  };
}

function mapPrinterForApi(p) {
  const connectionType = p.connection_type || p.connection || "lan";
  const statusRaw = p.status || "online";
  // Contract enum: online | offline | error
  let status = statusRaw;
  let statusDetail = p.status_detail != null ? String(p.status_detail) : null;
  if (statusRaw === "out_of_paper") {
    status = "error";
    statusDetail = statusDetail || "Out of paper";
  }
  const row = {
    external_id: String(p.external_id || p.externalId || "").trim(),
    name: String(p.name || "").trim(),
    connection_type: connectionType,
    // Desktop alias accepted by server
    connection: connectionType,
    status,
    status_detail: statusDetail,
    is_default: Boolean(p.is_default ?? p.isDefault),
  };
  if (p.model != null && String(p.model).trim() !== "") {
    row.model = String(p.model).trim();
  }
  if (p.ip_address != null && String(p.ip_address).trim() !== "") {
    row.ip_address = String(p.ip_address).trim();
  }
  return row;
}

function buildHeartbeatRequest({ appId, branchId, printers = [] }) {
  const body = {
    printers: (printers || []).map(mapPrinterForApi),
  };
  // Optional; when present must match token branch (§Desktop assumptions)
  if (appId != null && String(appId).trim() !== "") {
    body.app_id = String(appId).trim();
  }
  if (branchId != null && String(branchId).trim() !== "") {
    body.branch_id = String(branchId).trim();
  }
  return body;
}

function parseHeartbeatResponse(data) {
  if (!data || typeof data !== "object") {
    return {
      is_print_host: false,
      host_epoch: 1,
      pending_job_count: 0,
    };
  }
  // Flat root; tolerate accidental data wrapper
  const src =
    data.is_print_host == null && data.data && typeof data.data === "object"
      ? data.data
      : data;
  const epoch = Number(src.host_epoch ?? src.hostEpoch ?? 1);
  return {
    is_print_host: Boolean(src.is_print_host ?? src.isPrintHost),
    host_epoch: Number.isFinite(epoch) ? epoch : 1,
    pending_job_count: Number(src.pending_job_count ?? src.pendingJobCount ?? 0) || 0,
    station_printing_enabled: src.station_printing_enabled,
    server_time: src.server_time || null,
    raw: data,
  };
}

function buildAckRequest({
  status,
  reason,
  printedAt,
  printerExternalId,
  hostEpoch,
  retryable,
}) {
  const body = {
    status: status === "printed" ? "printed" : "failed",
  };
  if (reason != null && String(reason).trim() !== "") {
    body.reason = String(reason).trim();
  }
  if (printedAt) {
    body.printed_at = printedAt;
  }
  if (printerExternalId != null && String(printerExternalId).trim() !== "") {
    body.printer_external_id = String(printerExternalId).trim();
  }
  if (hostEpoch != null && Number.isFinite(Number(hostEpoch))) {
    body.host_epoch = Number(hostEpoch);
  }
  if (retryable != null) {
    body.retryable = Boolean(retryable);
  }
  return body;
}

function buildPrintersSyncRequest({ appId, branchId, printers }) {
  const body = {
    printers: (printers || []).map(mapPrinterForApi),
  };
  if (appId != null && String(appId).trim() !== "") {
    body.app_id = String(appId).trim();
  }
  if (branchId != null && String(branchId).trim() !== "") {
    body.branch_id = String(branchId).trim();
  }
  return body;
}

/**
 * Flat sync response: { accepted, printers: [{ id, external_id, … }] }
 */
function parsePrintersSyncResponse(data) {
  if (!data || typeof data !== "object") {
    return { accepted: 0, printers: [] };
  }
  const src =
    data.accepted == null && data.data && typeof data.data === "object"
      ? data.data
      : data;
  const printers = Array.isArray(src.printers) ? src.printers : [];
  return {
    accepted: Number(src.accepted) || printers.length,
    printers: printers.map((p) => ({
      id: p.id != null ? Number(p.id) : null,
      external_id: String(p.external_id || "").trim(),
      name: p.name != null ? String(p.name) : "",
      model: p.model != null ? String(p.model) : undefined,
      connection_type: p.connection_type || p.connection || "lan",
      ip_address: p.ip_address != null ? String(p.ip_address) : null,
      is_default: Boolean(p.is_default),
      status: p.status || "online",
      status_detail: p.status_detail != null ? String(p.status_detail) : null,
    })),
  };
}

function firstNonEmpty(...vals) {
  for (const v of vals) {
    if (v == null) continue;
    const s = typeof v === "string" ? v.trim() : String(v).trim();
    if (s !== "" && s !== "null") return s;
  }
  return "";
}

/**
 * Parse Rabbit v2 print message (contract §6).
 * PDF: prefer pdf_url (default), else pdf_base64; dual-run file_path.
 */
function parsePrintMessage(raw) {
  let data = raw;
  if (typeof raw === "string") {
    try {
      data = JSON.parse(raw);
    } catch {
      return { ok: false, error: "invalid_json" };
    }
  }
  if (!data || typeof data !== "object") {
    return { ok: false, error: "empty" };
  }

  const nestedPdf = data.pdf && typeof data.pdf === "object" ? data.pdf : null;
  const nestedPrinter =
    data.printer && typeof data.printer === "object" ? data.printer : null;
  const nestedStation =
    data.station && typeof data.station === "object" ? data.station : null;

  const schemaVersion = Number(data.schema_version ?? data.schemaVersion ?? data.v ?? 1);
  const jobId =
    data.job_id ?? data.jobId ?? data.print_job_id ?? data.printJobId ?? null;
  const orderId =
    data.order_id ?? data.orderId ?? data.OrderID ?? data.order_number ?? null;
  const printerExternalId = firstNonEmpty(
    data.printer_external_id,
    data.printerExternalId,
    nestedPrinter && nestedPrinter.external_id,
    data.external_printer_id
  );
  const hostEpochRaw = data.host_epoch ?? data.hostEpoch;
  const hostEpoch =
    hostEpochRaw != null && Number.isFinite(Number(hostEpochRaw))
      ? Number(hostEpochRaw)
      : null;
  const delayed = Boolean(data.delayed ?? data.is_delayed ?? data.isDelayed);
  const ticketType =
    data.ticket_type ?? data.ticketType ?? data.type ?? null;
  const stationIndex =
    data.station_index ??
    data.stationIndex ??
    (nestedStation && nestedStation.index) ??
    null;
  const stationCount =
    data.station_count ??
    data.stationCount ??
    (nestedStation && nestedStation.count) ??
    null;
  const stationName =
    data.station_name ??
    data.stationName ??
    (nestedStation && nestedStation.name) ??
    null;

  const pdfUrl = firstNonEmpty(
    data.pdf_url,
    data.pdfUrl,
    nestedPdf && nestedPdf.url
  );
  let pdfBase64 = firstNonEmpty(
    data.pdf_base64,
    data.pdfBase64,
    data.file_base64,
    data.fileBase64,
    data.base64_pdf,
    nestedPdf && nestedPdf.base64
  );
  // Null JSON becomes string "null" via firstNonEmpty guard — already filtered
  if (pdfBase64 === "null") pdfBase64 = "";

  const filePath = firstNonEmpty(
    data.file_path,
    data.filePath,
    data.pdf_path,
    data.pdfPath
  );
  const pdfSha256 = firstNonEmpty(
    data.pdf_sha256,
    data.pdfSha256,
    nestedPdf && nestedPdf.sha256
  );

  return {
    ok: true,
    schema_version: Number.isFinite(schemaVersion) ? schemaVersion : 1,
    job_id: jobId != null ? String(jobId).trim() : null,
    order_id:
      orderId != null && String(orderId).trim() !== ""
        ? String(orderId).trim()
        : null,
    printer_external_id: printerExternalId || null,
    host_epoch: hostEpoch,
    delayed,
    ticket_type: ticketType != null ? String(ticketType) : null,
    station_index: stationIndex != null ? Number(stationIndex) : null,
    station_count: stationCount != null ? Number(stationCount) : null,
    station_name: stationName != null ? String(stationName) : null,
    pdf_url: pdfUrl || null,
    pdf_base64: pdfBase64 || "",
    pdf_sha256: pdfSha256 || null,
    file_path: filePath || "",
    raw: data,
  };
}

function resolveApiUrl(apiBase, path) {
  const base = String(apiBase || "")
    .trim()
    .replace(/\/+$/, "");
  const p = String(path || "");
  if (!base) return p;
  if (/^https?:\/\//i.test(p)) return p;
  const prefix = ASSUMPTIONS.apiBasePath.replace(/\/+$/, "");
  if (p.startsWith(prefix) || p.startsWith("/api/")) {
    try {
      const u = new URL(base);
      if (u.pathname && u.pathname !== "/" && p.startsWith(u.pathname)) {
        return `${u.origin}${p}`;
      }
      if (u.pathname && u.pathname.includes("/api/")) {
        return `${u.origin}${p.startsWith("/") ? p : "/" + p}`;
      }
    } catch (_) {}
    return `${base}${p.startsWith("/") ? p : "/" + p}`;
  }
  return `${base}${prefix}${p.startsWith("/") ? p : "/" + p}`;
}

module.exports = {
  PLATFORM,
  ERROR_CODES,
  ENDPOINTS,
  ASSUMPTIONS,
  REMAINING_GAPS,
  buildRegisterRequest,
  parseRegisterResponse,
  parseHostConflictError,
  buildHeartbeatRequest,
  parseHeartbeatResponse,
  buildAckRequest,
  buildPrintersSyncRequest,
  parsePrintersSyncResponse,
  parsePrintMessage,
  resolveApiUrl,
  mapPrinterForApi,
};
