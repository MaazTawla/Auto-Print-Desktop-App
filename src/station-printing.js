/**
 * Station printing (Option A) facade used by main.js.
 * Keeps HostOnlyPolicy, agent API, app_id, and printer routing in one place.
 * Aligned to Backend contract v1.0.
 */

"use strict";

const os = require("os");
const { createHostOnlyPolicy } = require("./host-only-policy");
const { getOrCreateAppId } = require("./app-identity");
const { createPrinterRegistry } = require("./printer-registry");
const { createAgentApi } = require("./agent-api");
const {
  ASSUMPTIONS,
  REMAINING_GAPS,
  parsePrintMessage,
  ERROR_CODES,
  PLATFORM,
} = require("./agent-contract");

function createStationPrintingController(deps = {}) {
  const readConfig = deps.readConfig || (() => ({}));
  const writeConfig = deps.writeConfig || (() => {});
  const log = deps.log || ((msg) => console.log(msg));
  const onStateChange = deps.onStateChange || (() => {});
  const agentVersion = deps.agentVersion || null;

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
      contractVersion: ASSUMPTIONS.contractVersion,
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
   * Register as print host. pairing_code + role print_host required (contract §2.1).
   * On 409, Rabbit must stay idle.
   */
  async function registerAsHost({ branchId } = {}) {
    const cfg = readConfig();
    api.setApiBase(cfg.agent_api_base || "");
    // Register never sends bearer — pairing_code only
    api.setToken("");

    let result;
    try {
      result = await api.register({
        appId,
        branchId: branchId || cfg.branch_id,
        deviceLabel: cfg.device_label || defaultDeviceLabel(),
        pairingCode: cfg.pairing_code || "",
        role: ASSUMPTIONS.registerRole,
        agentVersion:
          agentVersion ||
          cfg.agent_version ||
          null,
      });
    } catch (err) {
      if (err && err.code === "VALIDATION_ERROR") {
        log(`Register validation: ${err.message}`, "❌");
        onStateChange(publicHostState());
        return {
          ok: false,
          error: { code: "VALIDATION_ERROR", message: err.message },
          shouldConsume: false,
        };
      }
      throw err;
    }

    if (!result.ok && result.conflict) {
      hostConflict = result.conflict;
      policy.revoke("print_host_already_configured");
      consumeEnabled = false;
      persistHostFlags();
      onStateChange(publicHostState());
      log(`Print host conflict: ${result.conflict.message}`, "⚠️");
      return { ok: false, conflict: result.conflict, shouldConsume: false };
    }

    if (!result.ok) {
      log(
        `Register failed: ${(result.error && result.error.message) || "unknown"}`,
        "❌"
      );
      onStateChange(publicHostState());
      return { ok: false, error: result.error, shouldConsume: false };
    }

    hostConflict = null;
    if (result.token) {
      writeConfig({ agent_token: result.token });
      api.setToken(result.token);
    }
    if (result.heartbeat_interval_seconds) {
      writeConfig({
        heartbeat_interval_seconds: result.heartbeat_interval_seconds,
        heartbeat_ttl_seconds: result.heartbeat_ttl_seconds || 90,
      });
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
      rabbit: result.rabbit || null,
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
    try {
      await api.deregister({});
    } catch (_) {}
    policy.revoke("deregister");
    consumeEnabled = false;
    persistHostFlags();
    onStateChange(publicHostState());
  }

  async function syncPrintersToServer({ branchId } = {}) {
    const cfg = readConfig();
    if (!api.getToken()) return { ok: false, skipped: true };
    const result = await api.syncPrinters({
      appId,
      branchId: branchId || cfg.branch_id,
      printers: printers.toSyncPayload(),
    });
    if (result.ok && Array.isArray(result.printers) && result.printers.length) {
      printers.applyServerSync(result.printers);
      persistHostFlags();
      onStateChange(publicHostState());
    }
    return result;
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
      printerExternalId: extra.printerExternalId || extra.printer_external_id,
      hostEpoch: extra.hostEpoch != null ? extra.hostEpoch : policy.hostEpoch,
    });
  }

  async function ackFailed(jobId, reason, extra = {}) {
    if (!jobId || !api.getToken()) return { ok: false, skipped: true };
    return api.ackJob(jobId, {
      status: "failed",
      reason: reason || "print_failed",
      printerExternalId: extra.printerExternalId || extra.printer_external_id,
      hostEpoch: extra.hostEpoch != null ? extra.hostEpoch : policy.hostEpoch,
      retryable: extra.retryable,
    });
  }

  async function reportStatus(printerExternalId, payload) {
    if (!printerExternalId || !api.getToken()) return { ok: false, skipped: true };
    const row = printers.get(printerExternalId);
    const pathId =
      (row && row.server_id != null ? String(row.server_id) : null) ||
      printerExternalId;
    return api.reportPrinterStatus(pathId, {
      ...(payload || {}),
      external_id: printerExternalId,
    });
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

  /** Consume options: exclusive must be false; prefetch is set on the channel. */
  function rabbitConsumeOptions() {
    return {
      exclusive: ASSUMPTIONS.consumeExclusive === true,
      noAck: false,
    };
  }

  return {
    appId,
    ERROR_CODES,
    ASSUMPTIONS,
    REMAINING_GAPS,
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
    rabbitConsumeOptions,
    get flushPending() {
      return flushPending;
    },
    get hostConflict() {
      return hostConflict;
    },
  };
}

module.exports = { createStationPrintingController };
