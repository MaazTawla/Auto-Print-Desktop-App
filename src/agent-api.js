/**
 * Print-agent HTTP client: register / heartbeat / deregister / printers-sync / ack / status.
 * Uses axios when available; injectable `request` for tests.
 */

"use strict";

const {
  ENDPOINTS,
  ASSUMPTIONS,
  buildRegisterRequest,
  parseRegisterResponse,
  parseHostConflictError,
  buildHeartbeatRequest,
  parseHeartbeatResponse,
  buildAckRequest,
  buildPrintersSyncRequest,
  resolveApiUrl,
  ERROR_CODES,
} = require("./agent-contract");

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
    const bearer = opts.token != null ? opts.token : token;
    if (bearer) headers.Authorization = `Bearer ${bearer}`;

    const res = await request({
      method,
      url,
      headers,
      data: body,
      timeout: opts.timeout != null ? opts.timeout : 20000,
      validateStatus: () => true,
    });

    const status = res.status;
    const data = res.data;
    return { status, data, headers: res.headers || {} };
  }

  async function register(fields) {
    const body = buildRegisterRequest(fields);
    const { status, data } = await call("POST", ENDPOINTS.register, body, {
      token: fields.pairingToken || token || undefined,
    });
    if (status === 409) {
      const conflict = parseHostConflictError(data, status);
      return {
        ok: false,
        status,
        conflict: conflict || {
          code: ERROR_CODES.PRINT_HOST_ALREADY_CONFIGURED,
          message: "Another device is already configured as print host for this branch.",
          current_host: null,
        },
      };
    }
    if (status < 200 || status >= 300) {
      return {
        ok: false,
        status,
        error: {
          code: (data && data.error && data.error.code) || "REGISTER_FAILED",
          message:
            (data && data.error && data.error.message) ||
            (data && data.message) ||
            `Register failed (${status})`,
        },
      };
    }
    const parsed = parseRegisterResponse(data);
    if (parsed.token) setToken(parsed.token);
    return { ok: true, status, ...parsed };
  }

  async function heartbeat(fields) {
    const body = buildHeartbeatRequest(fields);
    const { status, data } = await call("POST", ENDPOINTS.heartbeat, body);
    if (status === 401 || status === 403) {
      return {
        ok: false,
        status,
        authError: true,
        error: { code: "UNAUTHORIZED", message: "Agent token rejected" },
      };
    }
    if (status < 200 || status >= 300) {
      return {
        ok: false,
        status,
        error: {
          code: "HEARTBEAT_FAILED",
          message:
            (data && data.error && data.error.message) ||
            `Heartbeat failed (${status})`,
        },
      };
    }
    return { ok: true, status, ...parseHeartbeatResponse(data) };
  }

  async function deregister(fields = {}) {
    const body = {
      app_id: fields.appId != null ? String(fields.appId) : undefined,
      branch_id: fields.branchId != null ? String(fields.branchId) : undefined,
    };
    const { status, data } = await call("POST", ENDPOINTS.deregister, body);
    return { ok: status >= 200 && status < 300, status, data };
  }

  async function syncPrinters(fields) {
    const body = buildPrintersSyncRequest(fields);
    const { status, data } = await call("POST", ENDPOINTS.printersSync, body);
    return { ok: status >= 200 && status < 300, status, data };
  }

  async function ackJob(jobId, { status: jobStatus, reason, printedAt }) {
    const body = buildAckRequest({ status: jobStatus, reason, printedAt });
    const { status, data } = await call(
      "POST",
      ENDPOINTS.jobAck(jobId),
      body
    );
    return { ok: status >= 200 && status < 300, status, data };
  }

  async function reportPrinterStatus(printerId, payload) {
    const { status, data } = await call(
      "POST",
      ENDPOINTS.printerStatus(printerId),
      payload || {}
    );
    return { ok: status >= 200 && status < 300, status, data };
  }

  return {
    setApiBase,
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
