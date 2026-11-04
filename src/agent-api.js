/**
 * Print-agent HTTP client: register / heartbeat / deregister / printers-sync / ack / status.
 * Contract v1.0 — flat success bodies; register uses pairing_code (no bearer).
 */

"use strict";

const {
  ENDPOINTS,
  ASSUMPTIONS,
  buildRegisterRequest,
  parseRegisterResponse,
  parseHostConflictError,
  parseSyncConflictError,
  buildHeartbeatRequest,
  parseHeartbeatResponse,
  buildAckRequest,
  buildPrintersSyncRequest,
  parsePrintersSyncResponse,
  parseAckResponse,
  parsePrinterStatusResponse,
  parseAgentError,
  resolveApiUrl,
  ERROR_CODES,
} = require("./agent-contract");
const {
  parseRetryAfterMs,
  shouldUnpairImmediately,
} = require("./agent-http-retry-policy");
const { retryAfterSeconds } = require("./pairing-errors");

function createAgentApi(options = {}) {
  let apiBase = String(options.apiBase || "").trim();
  let token = options.token != null ? String(options.token) : "";
  const request =
    typeof options.request === "function"
      ? options.request
      : defaultAxiosRequest;

  function setApiBase(base) {
    apiBase = String(base || "").trim();
  }

  function getApiBase() {
    return apiBase;
  }

  function setToken(t) {
    token = t != null ? String(t) : "";
  }

  function getToken() {
    return token;
  }

  async function call(method, path, body, opts = {}) {
    const url = resolveApiUrl(apiBase, path);
    if (!apiBase && !/^https?:\/\//i.test(path)) {
      const err = new Error("Agent API base URL is not configured");
      err.code = "API_BASE_MISSING";
      throw err;
    }
    const headers = {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    };
    if (opts.noAuth) {
      // register: pairing_code in body only
    } else {
      const bearer = opts.token != null ? opts.token : token;
      if (bearer) headers.Authorization = `Bearer ${bearer}`;
    }

    const res = await request({
      method,
      url,
      headers,
      data: body,
      timeout: opts.timeout != null ? opts.timeout : 20000,
      validateStatus: () => true,
    });

    return {
      status: res.status,
      data: res.data,
      headers: res.headers || {},
    };
  }

  async function register(fields) {
    const body = buildRegisterRequest(fields);
    // No bearer on register (contract §2.1)
    const { status, data, headers } = await call("POST", ENDPOINTS.register, body, {
      noAuth: true,
    });
    if (status === 409) {
      // v1.21: only a real host conflict takes the conflict path (credential drop).
      // PAIRING_BUSY and unknown 409 codes are plain errors (no credential wipe).
      const conflict = parseHostConflictError(data, status);
      if (conflict) {
        return { ok: false, status, conflict };
      }
    }
    if (status < 200 || status >= 300) {
      const error = parseAgentError(data, status);
      const out = {
        ok: false,
        status,
        error,
        code: error.code,
        message: error.message,
      };
      if (status === 429) {
        const details = (error && error.details) || {};
        const bodySec =
          details.retry_after_seconds != null
            ? details.retry_after_seconds
            : data && typeof data === "object"
              ? data.retry_after_seconds
              : null;
        const headerMs = parseRetryAfterMs(
          headers && (headers["retry-after"] || headers["Retry-After"])
        );
        out.code = ERROR_CODES.PAIRING_RATE_LIMITED;
        out.error = { ...error, code: ERROR_CODES.PAIRING_RATE_LIMITED };
        out.retryAfterSeconds = retryAfterSeconds(bodySec, headerMs);
      }
      return out;
    }
    const parsed = parseRegisterResponse(data);
    if (parsed.token) setToken(parsed.token);
    return { ok: true, status, ...parsed };
  }

  async function heartbeat(fields) {
    const body = buildHeartbeatRequest(fields);
    const callOpts = {};
    if (fields && fields.timeout != null) callOpts.timeout = fields.timeout;
    const { status, data, headers } = await call(
      "POST",
      ENDPOINTS.heartbeat,
      body,
      callOpts
    );
    if (status === 401 || status === 403) {
      const parsed = parseAgentError(data, status);
      const code =
        (parsed && parsed.code) ||
        (status === 401 ? "UNAUTHORIZED" : "FORBIDDEN");
      return {
        ok: false,
        status,
        authError: shouldUnpairImmediately(status, code),
        error: {
          code,
          message:
            (parsed && parsed.message) ||
            (status === 401
              ? "Agent token rejected"
              : "Agent forbidden"),
        },
        code,
        headers,
      };
    }
    // v1.4 M5: heartbeat printer upsert can return 409 SYNC_CONFLICT (same as printers/sync)
    if (status === 409) {
      const syncConflict = parseSyncConflictError(data, status);
      if (syncConflict) {
        return {
          ok: false,
          status,
          syncConflict: true,
          code: ERROR_CODES.SYNC_CONFLICT,
          error: syncConflict,
          message: syncConflict.message,
        };
      }
    }
    if (status < 200 || status >= 300) {
      const parsed = parseAgentError(data, status);
      return {
        ok: false,
        status,
        error: {
          code: parsed.code || "HEARTBEAT_FAILED",
          message:
            parsed.message ||
            (data && data.error && data.error.message) ||
            `Heartbeat failed (${status})`,
        },
        code: parsed.code || "HEARTBEAT_FAILED",
        headers,
        retryAfterMs: parseRetryAfterMs(
          headers && (headers["retry-after"] || headers["Retry-After"])
        ),
      };
    }
    return { ok: true, status, ...parseHeartbeatResponse(data) };
  }

  async function deregister(fields = {}) {
    const body =
      fields.reason != null
        ? { reason: String(fields.reason) }
        : {};
    const { status, data } = await call("POST", ENDPOINTS.deregister, body);
    return { ok: status >= 200 && status < 300, status, data };
  }

  async function syncPrinters(fields) {
    const body = buildPrintersSyncRequest(fields);
    const callOpts = {};
    if (fields && fields.timeout != null) callOpts.timeout = fields.timeout;
    const { status, data } = await call(
      "POST",
      ENDPOINTS.printersSync,
      body,
      callOpts
    );
    if (status === 401 || status === 403) {
      const error = parseAgentError(data, status);
      const code = error.code || (status === 401 ? "UNAUTHORIZED" : "FORBIDDEN");
      return {
        ok: false,
        status,
        authError: shouldUnpairImmediately(status, code),
        error: { ...error, code },
        code,
        message: error.message,
        ...parsePrintersSyncResponse({}),
      };
    }
    // v1.4 M5: 409 SYNC_CONFLICT — retryable; not PRINT_HOST_ALREADY_CONFIGURED
    if (status === 409) {
      const syncConflict = parseSyncConflictError(data, status);
      if (syncConflict) {
        return {
          ok: false,
          status,
          syncConflict: true,
          code: ERROR_CODES.SYNC_CONFLICT,
          error: syncConflict,
          message: syncConflict.message,
          data,
          ...parsePrintersSyncResponse({}),
        };
      }
      const error = parseAgentError(data, status);
      return {
        ok: false,
        status,
        error,
        code: error.code,
        message: error.message,
        data,
        ...parsePrintersSyncResponse({}),
      };
    }
    if (status < 200 || status >= 300) {
      const error = parseAgentError(data, status);
      return {
        ok: false,
        status,
        error,
        code: error.code,
        message: error.message,
        data,
        ...parsePrintersSyncResponse({}),
      };
    }
    return { ok: true, status, ...parsePrintersSyncResponse(data), raw: data };
  }

  async function ackJob(jobId, opts) {
    const body = buildAckRequest(opts || {});
    const { status, data, headers } = await call(
      "POST",
      ENDPOINTS.jobAck(jobId),
      body
    );
    const retryAfterMs = parseRetryAfterMs(
      headers && (headers["retry-after"] || headers["Retry-After"])
    );
    const parsed = parseAckResponse(data, status);
    if (!parsed.ok) {
      return {
        ok: false,
        status,
        authError: shouldUnpairImmediately(
          status,
          parsed.error && parsed.error.code
        ),
        error: parsed.error,
        code: parsed.error.code,
        message: parsed.error.message,
        data,
        retryAfterMs,
        headers,
      };
    }
    return { ok: true, status, ...parsed, retryAfterMs };
  }

  async function reportPrinterStatus(printerId, payload) {
    const pathId =
      printerId != null && String(printerId).trim() !== ""
        ? printerId
        : "0";
    const { status, data } = await call(
      "POST",
      ENDPOINTS.printerStatus(pathId),
      payload || {}
    );
    const parsed = parsePrinterStatusResponse(data, status);
    if (!parsed.ok) {
      return {
        ok: false,
        status,
        authError: shouldUnpairImmediately(
          status,
          parsed.error && parsed.error.code
        ),
        error: parsed.error,
        code: parsed.error.code,
        message: parsed.error.message,
        data,
      };
    }
    return { ok: true, status, ...parsed };
  }

  return {
    setApiBase,
    getApiBase,
    setToken,
    getToken,
    register,
    heartbeat,
    deregister,
    syncPrinters,
    ackJob,
    reportPrinterStatus,
    ASSUMPTIONS,
  };
}

async function defaultAxiosRequest(cfg) {
  const axios = require("axios");
  return axios({
    method: cfg.method,
    url: cfg.url,
    headers: cfg.headers,
    data: cfg.data,
    timeout: cfg.timeout,
    validateStatus: cfg.validateStatus,
  });
}

module.exports = { createAgentApi };
