/**
 * Station printing (Option A) facade used by main.js.
 * Keeps HostOnlyPolicy, agent API, app_id, and printer routing in one place.
 */

"use strict";

const os = require("os");
const { createHostOnlyPolicy } = require("./host-only-policy");
const { getOrCreateAppId } = require("./app-identity");
const { createPrinterRegistry } = require("./printer-registry");
const { createAgentApi } = require("./agent-api");
const {
  ASSUMPTIONS,
  parsePrintMessage,
  ERROR_CODES,
  PLATFORM,
} = require("./agent-contract");

function createStationPrintingController(deps = {}) {
  const readConfig = deps.readConfig || (() => ({}));
  const writeConfig = deps.writeConfig || (() => {});
  const log = deps.log || ((msg) => console.log(msg));
  const onStateChange = deps.onStateChange || (() => {});

  const appId = getOrCreateAppId({ readConfig, writeConfig });
  const policy = createHostOnlyPolicy({
    isPrintHost: Boolean(readConfig().is_print_host),
    hostEpoch: Number(readConfig().host_epoch) || 1,
  });
  const printers = createPrinterRegistry();
  try {
    const saved = readConfig().printer_registry;
    if (saved) printers.hydrate(saved);
  } catch (_) {}

  const api = createAgentApi({
    apiBase: readConfig().agent_api_base || "",
    token: readConfig().agent_token || "",
    request: deps.request,
  });

  let hostConflict = null; // 409 payload for UI
  let lastHeartbeatAt = null;
  let consumeEnabled = policy.shouldConsume();
  let flushPending = false;

  function persistHostFlags() {
    const snap = policy.snapshot();
    writeConfig({
      app_id: appId,
      is_print_host: snap.isPrintHost,
      host_epoch: snap.hostEpoch,
      printer_registry: printers.serialize(),
    });
  }

  function publicHostState() {
    return {
      appId,
      platform: PLATFORM,
      isPrintHost: policy.isPrintHost,
      hostEpoch: policy.hostEpoch,
      shouldConsume: policy.shouldConsume(),
      hostConflict,
      lastHeartbeatAt,
      pendingFlush: flushPending,
      printers: printers.list(),
      defaultPrinterExternalId: (printers.getDefault() || {}).external_id || null,
      agentTokenConfigured: Boolean(api.getToken()),
      agentApiBase: String(readConfig().agent_api_base || ""),
      deviceLabel: String(readConfig().device_label || defaultDeviceLabel()),
      pairingCodeConfigured: Boolean(String(readConfig().pairing_code || "").trim()),
    };
  }

  function defaultDeviceLabel() {
    try {
      return `${os.hostname()} - Desktop Print Agent`;
    } catch {
      return "Desktop Print Agent";
    }
  }

  function setApiBase(base) {
    api.setApiBase(base);
    writeConfig({ agent_api_base: String(base || "").trim() });
  }

  function setDeviceLabel(label) {
    writeConfig({ device_label: String(label || "").trim() });
  }

  function setPairingCode(code) {
    writeConfig({ pairing_code: String(code || "").trim() });
  }

  function clearHostConflict() {
    hostConflict = null;
    onStateChange(publicHostState());
  }

  /**
   * Register as print host. On 409, Rabbit must stay idle.
   */
  async function registerAsHost({ branchId } = {}) {
    const cfg = readConfig();
    api.setApiBase(cfg.agent_api_base || "");
    if (cfg.agent_token) api.setToken(cfg.agent_token);

    const result = await api.register({
      appId,
      branchId: branchId || cfg.branch_id,
      deviceLabel: cfg.device_label || defaultDeviceLabel(),
      pairingCode: cfg.pairing_code || "",
      hostEpoch: policy.hostEpoch,
    });

    if (!result.ok && result.conflict) {
      hostConflict = result.conflict;
      policy.revoke("print_host_already_configured");
      consumeEnabled = false;
      persistHostFlags();
      onStateChange(publicHostState());
      log(
        `Print host conflict: ${result.conflict.message}`,
        "⚠️"
      );
      return { ok: false, conflict: result.conflict, shouldConsume: false };
    }

    if (!result.ok) {
      log(`Register failed: ${(result.error && result.error.message) || "unknown"}`, "❌");
      onStateChange(publicHostState());
      return { ok: false, error: result.error, shouldConsume: false };
    }

    hostConflict = null;
    if (result.token) {
      writeConfig({ agent_token: result.token });
      api.setToken(result.token);
    }
    const applied = policy.applyServerState({
      is_print_host: result.is_print_host,
      host_epoch: result.host_epoch,
    });
    consumeEnabled = applied.shouldConsume;
    if (applied.promoted) flushPending = true;
    persistHostFlags();
    onStateChange(publicHostState());
    log(
      result.is_print_host
        ? `Registered as print host (epoch ${result.host_epoch}).`
        : "Registered — not print host; Rabbit consumer stays idle.",
      result.is_print_host ? "✅" : "ℹ️"
    );
    return {
      ok: true,
      shouldConsume: consumeEnabled,
      promoted: applied.promoted,
      revoked: applied.revoked,
    };
  }

  async function heartbeat({ branchId } = {}) {
    const cfg = readConfig();
    if (!api.getToken() || !(cfg.agent_api_base || "").trim()) {
      return { ok: false, skipped: true, shouldConsume: consumeEnabled };
    }
    api.setApiBase(cfg.agent_api_base || "");
    const result = await api.heartbeat({
      appId,
      branchId: branchId || cfg.branch_id,
      hostEpoch: policy.hostEpoch,
      printers: printers.toSyncPayload(),
    });
    lastHeartbeatAt = new Date().toISOString();

    if (!result.ok) {
      onStateChange(publicHostState());
      return { ok: false, error: result.error, shouldConsume: consumeEnabled };
    }

    const applied = policy.applyServerState({
      is_print_host: result.is_print_host,
      host_epoch: result.host_epoch,
    });
    consumeEnabled = applied.shouldConsume;
    if (applied.promoted) flushPending = true;
    if (applied.revoked) {
      log(
        `Print host revoked (epoch ${result.host_epoch}) — stopping consumer.`,
        "⚠️"
      );
    }
    persistHostFlags();
    onStateChange(publicHostState());
    return {
      ok: true,
      shouldConsume: consumeEnabled,
      revoked: applied.revoked,
      promoted: applied.promoted,
      pending_job_count: result.pending_job_count,
      flushPending,
    };
  }

  async function deregister() {
    const cfg = readConfig();
    try {
      await api.deregister({ appId, branchId: cfg.branch_id });
    } catch (_) {}
    policy.revoke("deregister");
    consumeEnabled = false;
    persistHostFlags();
    onStateChange(publicHostState());
  }

  async function syncPrintersToServer({ branchId } = {}) {
    const cfg = readConfig();
    if (!api.getToken()) return { ok: false, skipped: true };
    return api.syncPrinters({
      appId,
      branchId: branchId || cfg.branch_id,
      printers: printers.toSyncPayload(),
    });
  }

  function syncWindowsPrinters(windowsList) {
    const list = printers.syncFromWindowsList(windowsList);
    persistHostFlags();
    onStateChange(publicHostState());
    return list;
  }

  function setDefaultPrinter(externalIdOrName) {
    const id = String(externalIdOrName || "").trim();
    if (!id) return false;
    if (!printers.setDefault(id)) {
      // try by windows name
      const row = printers.list().find(
        (p) => p.windows_name === id || p.name === id
      );
      if (!row) return false;
      printers.setDefault(row.external_id);
    }
    persistHostFlags();
    onStateChange(publicHostState());
    return true;
  }

  /**
   * Evaluate an inbound Rabbit payload under HostOnlyPolicy.
   * Returns { action, parsed, route, reason }.
   */
  function evaluateIncomingMessage(rawMessage) {
    const parsed = parsePrintMessage(rawMessage);
    if (!parsed.ok) {
      return { action: "reject", parsed, reason: parsed.error || "parse_error" };
    }
    const decision = policy.decideMessage(parsed, {
      requirePrinterExternalId: false,
    });
    if (decision.action !== "print") {
      return {
        action: decision.action === "nack" ? "nack" : "reject",
        parsed,
        reason: decision.reason,
      };
    }
    const route = printers.routeMessage(parsed);
    if (!route.ok) {
      return {
        action: "nack",
        parsed,
        reason: route.reason,
        route,
      };
    }
    return { action: "print", parsed, route, reason: null };
  }

  async function ackPrinted(jobId, extra = {}) {
    if (!jobId || !api.getToken()) return { ok: false, skipped: true };
    return api.ackJob(jobId, {
      status: "printed",
      printedAt: extra.printedAt || new Date().toISOString(),
    });
  }

  async function ackFailed(jobId, reason) {
    if (!jobId || !api.getToken()) return { ok: false, skipped: true };
    return api.ackJob(jobId, { status: "failed", reason: reason || "print_failed" });
  }

  async function reportStatus(printerExternalId, payload) {
    if (!printerExternalId || !api.getToken()) return { ok: false, skipped: true };
    return api.reportPrinterStatus(printerExternalId, payload);
  }

  function markFlushDone() {
    flushPending = false;
    onStateChange(publicHostState());
  }

  function shouldConsume() {
    return policy.shouldConsume();
  }

  function rabbitConsumeArgs() {
    // Prefer single-active-consumer so a second device is standby only.
    return ASSUMPTIONS.rabbitSingleActiveConsumer
      ? { "x-single-active-consumer": true }
      : {};
  }

  return {
    appId,
    ERROR_CODES,
    ASSUMPTIONS,
    policy,
    printers,
    api,
    publicHostState,
    setApiBase,
    setDeviceLabel,
    setPairingCode,
    clearHostConflict,
    registerAsHost,
    heartbeat,
    deregister,
    syncPrintersToServer,
    syncWindowsPrinters,
    setDefaultPrinter,
    evaluateIncomingMessage,
    ackPrinted,
    ackFailed,
    reportStatus,
    markFlushDone,
    shouldConsume,
    rabbitConsumeArgs,
    get flushPending() {
      return flushPending;
    },
    get hostConflict() {
      return hostConflict;
    },
  };
}

module.exports = { createStationPrintingController };
