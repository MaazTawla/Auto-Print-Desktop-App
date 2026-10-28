/**
 * Print-agent API contract (station printing Option A).
 * Endpoints and DTO shapes live here until Backend finalizes them.
 * Base path: /api/v1/print-agent
 *
 * Assumptions Backend must confirm are listed in ASSUMPTIONS below.
 */

"use strict";

const PLATFORM = "desktop";

const ERROR_CODES = Object.freeze({
  PRINT_HOST_ALREADY_CONFIGURED: "PRINT_HOST_ALREADY_CONFIGURED",
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
 * Backend confirmation needed:
 * - Exact base URL path (/api/v1/print-agent vs merchant-scoped).
 * - Pairing: body field `pairing_code` vs header; token field name (`token` vs `access_token`).
 * - Register body: `role: "print_host"` vs auto-claim when none set.
 * - Heartbeat interval (plan suggests 45–90s online expiry) — client uses 30s.
 * - Rabbit consume: prefer `x-single-active-consumer` (we declare SAC); confirm Backend will not recreate without SAC.
 * - v2 message field names: printer_external_id, job_id, host_epoch, delayed, ticket_type.
 * - Ack body: { status: "printed"|"failed", reason?, printed_at? }.
 * - printers/sync body shape and whether server assigns printer ids.
 */
const ASSUMPTIONS = Object.freeze({
  apiBasePath: "/api/v1/print-agent",
  heartbeatIntervalMs: 30000,
  registerRole: "print_host",
  rabbitSingleActiveConsumer: true,
  messageSchemaVersion: 2,
});

function buildRegisterRequest({
  appId,
  branchId,
  platform = PLATFORM,
  deviceLabel,
  pairingCode,
  role = ASSUMPTIONS.registerRole,
  hostEpoch,
}) {
  const body = {
    app_id: String(appId || "").trim(),
    branch_id: String(branchId || "").trim(),
    platform,
    device_label: String(deviceLabel || "").trim() || undefined,
    role,
  };
  if (pairingCode != null && String(pairingCode).trim() !== "") {
    body.pairing_code = String(pairingCode).trim();
  }
  if (hostEpoch != null && Number.isFinite(Number(hostEpoch))) {
    body.host_epoch = Number(hostEpoch);
  }
  return body;
}

function parseRegisterResponse(data) {
  if (!data || typeof data !== "object") {
    return { ok: false, error: { code: "BAD_RESPONSE", message: "Empty register response" } };
  }
  const token =
    data.token ?? data.access_token ?? data.agent_token ?? (data.data && data.data.token);
  const isPrintHost = Boolean(
    data.is_print_host ?? data.isPrintHost ?? (data.data && data.data.is_print_host)
  );
  const hostEpoch = Number(
    data.host_epoch ?? data.hostEpoch ?? (data.data && data.data.host_epoch) ?? 1
  );
  return {
    ok: true,
    token: token != null ? String(token) : "",
    is_print_host: isPrintHost,
    host_epoch: Number.isFinite(hostEpoch) ? hostEpoch : 1,
    app_id: data.app_id != null ? String(data.app_id) : null,
    raw: data,
  };
}

/**
 * Parse 409 PRINT_HOST_ALREADY_CONFIGURED body (plan §4.2).
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
          is_online: Boolean(
            current.is_online ?? current.isOnline ?? false
          ),
        }
      : null,
  };
}

function buildHeartbeatRequest({
  appId,
  branchId,
  hostEpoch,
  printers = [],
  isOnline = true,
}) {
  return {
    app_id: String(appId || "").trim(),
    branch_id: String(branchId || "").trim(),
    host_epoch: Number.isFinite(Number(hostEpoch)) ? Number(hostEpoch) : undefined,
    is_online: !!isOnline,
    printers: (printers || []).map((p) => ({
      external_id: String(p.external_id || p.externalId || "").trim(),
      name: String(p.name || "").trim(),
      connection: p.connection || p.connection_type || "lan",
      status: p.status || "online",
      is_default: Boolean(p.is_default ?? p.isDefault),
    })),
  };
}

function parseHeartbeatResponse(data) {
  if (!data || typeof data !== "object") {
    return {
      is_print_host: false,
      host_epoch: 1,
      pending_job_count: 0,
    };
  }
  const src = data.data && typeof data.data === "object" ? data.data : data;
  const epoch = Number(src.host_epoch ?? src.hostEpoch ?? 1);
  return {
    is_print_host: Boolean(src.is_print_host ?? src.isPrintHost),
    host_epoch: Number.isFinite(epoch) ? epoch : 1,
    pending_job_count: Number(src.pending_job_count ?? src.pendingJobCount ?? 0) || 0,
    raw: data,
  };
}

function buildAckRequest({ status, reason, printedAt }) {
  const body = {
    status: status === "printed" ? "printed" : "failed",
  };
  if (reason != null && String(reason).trim() !== "") {
    body.reason = String(reason).trim();
  }
  if (printedAt) {
    body.printed_at = printedAt;
  }
  return body;
}

function buildPrintersSyncRequest({ appId, branchId, printers }) {
  return {
    app_id: String(appId || "").trim(),
    branch_id: String(branchId || "").trim(),
    printers: (printers || []).map((p) => ({
      external_id: String(p.external_id || p.externalId || "").trim(),
      name: String(p.name || "").trim(),
      connection: p.connection || "lan",
      status: p.status || "online",
      is_default: Boolean(p.is_default ?? p.isDefault),
      model: p.model != null ? String(p.model) : undefined,
    })),
  };
}

/**
 * Parse Rabbit v2 print message (plan §7).
 * Supports legacy v1 (pdf_base64 / file_path only) for dual-run.
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

  const schemaVersion = Number(data.schema_version ?? data.schemaVersion ?? data.v ?? 1);
  const jobId =
    data.job_id ?? data.jobId ?? data.print_job_id ?? data.printJobId ?? null;
  const orderId =
    data.order_id ?? data.orderId ?? data.OrderID ?? data.order_number ?? null;
  const printerExternalId =
    data.printer_external_id ??
    data.printerExternalId ??
    data.external_printer_id ??
    data.printer_id ??
    null;
  const hostEpochRaw = data.host_epoch ?? data.hostEpoch;
  const hostEpoch =
    hostEpochRaw != null && Number.isFinite(Number(hostEpochRaw))
      ? Number(hostEpochRaw)
      : null;
  const delayed = Boolean(data.delayed ?? data.is_delayed ?? data.isDelayed);
  const ticketType =
    data.ticket_type ?? data.ticketType ?? data.type ?? null;
  const stationIndex = data.station_index ?? data.stationIndex ?? null;
  const stationCount = data.station_count ?? data.stationCount ?? null;
  const stationName = data.station_name ?? data.stationName ?? null;

  const pdfBase64 =
    data.pdf_base64 ??
    data.pdfBase64 ??
    data.file_base64 ??
    data.fileBase64 ??
    data.base64_pdf ??
    "";
  const filePath =
    data.file_path ??
    data.filePath ??
    data.pdf_path ??
    data.pdfPath ??
    data.pdf_url ??
    data.pdfUrl ??
    "";

  return {
    ok: true,
    schema_version: Number.isFinite(schemaVersion) ? schemaVersion : 1,
    job_id: jobId != null ? String(jobId).trim() : null,
    order_id: orderId != null && String(orderId).trim() !== "" ? String(orderId).trim() : null,
    printer_external_id:
      printerExternalId != null && String(printerExternalId).trim() !== ""
        ? String(printerExternalId).trim()
        : null,
    host_epoch: hostEpoch,
    delayed,
    ticket_type: ticketType != null ? String(ticketType) : null,
    station_index: stationIndex != null ? Number(stationIndex) : null,
    station_count: stationCount != null ? Number(stationCount) : null,
    station_name: stationName != null ? String(stationName) : null,
    pdf_base64: typeof pdfBase64 === "string" ? pdfBase64.trim() : String(pdfBase64 || "").trim(),
    file_path: typeof filePath === "string" ? filePath.trim() : String(filePath || "").trim(),
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
    // apiBase may already include /api/v1 or be origin only
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
  buildRegisterRequest,
  parseRegisterResponse,
  parseHostConflictError,
  buildHeartbeatRequest,
  parseHeartbeatResponse,
  buildAckRequest,
  buildPrintersSyncRequest,
  parsePrintMessage,
  resolveApiUrl,
};
