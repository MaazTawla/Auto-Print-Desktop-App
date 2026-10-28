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
  syncConflictBackoffMs,
  rabbitConfigToPersistPatch,
  resolveQueueDeclareOptions,
  resolveQueueName,
  normalizeRabbitConfig,
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
  let lastRegisterError = null; // { code, message } for inline UI
  let needsPairing = false; // prompt UI after token revoke / deregister
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
      pairingError: lastRegisterError,
      lastRegisterError,
      needsPairing: Boolean(needsPairing),
      pairingPrompt:
        needsPairing
          ? "Agent token was revoked or cleared. Enter a fresh pairing code, then Save & register."
          : null,
      contractVersion: ASSUMPTIONS.contractVersion,
      rabbitQueue: resolveQueueName(readConfig(), readConfig().branch_id),
      pdfHost: String(readConfig().pdf_host || "").trim() || null,
      queuePreconditionHint: readConfig().queue_precondition_hint || null,
      secretsEncryptionUnavailable: Boolean(
        readConfig().secrets_encryption_unavailable
      ),
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
   * Clear local agent auth after deregister or 401/403 token revoke.
   * Deletes token, host flags, epoch; clears pairing code so a fresh one is required.
   */
  function clearLocalAuth(reason) {
    api.setToken("");
    policy.revoke(reason || "token_cleared");
    policy.applyServerState({ is_print_host: false, host_epoch: 1 });
    consumeEnabled = false;
    needsPairing = true;
    hostConflict = null;
    writeConfig({
      agent_token: "",
      rabbit_password: "",
      pairing_code: "",
      is_print_host: false,
      host_epoch: 1,
      pdf_host: "",
      queue_precondition_hint: null,
    });
    persistHostFlags();
    onStateChange(publicHostState());
    log(
      `Agent session cleared (${reason || "auth"}) — enter a fresh pairing code to register again.`,
      "⚠️"
    );
  }

  function handleAuthFailure(result, context) {
    if (!result || !result.authError) return false;
    clearLocalAuth(context || "token_revoked");
    lastRegisterError = {
      code: (result.error && result.error.code) || "UNAUTHORIZED",
      message:
        (result.error && result.error.message) ||
        "Agent token rejected. Enter a fresh pairing code.",
    };
    return true;
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
      if (
        err &&
        (err.code === ERROR_CODES.PAIRING_CODE_REQUIRED ||
          err.code === "VALIDATION_ERROR" ||
          err.code === ERROR_CODES.VALIDATION_ERROR)
      ) {
        lastRegisterError = {
          code: err.code || ERROR_CODES.PAIRING_CODE_REQUIRED,
          message: err.message || "Pairing code is required.",
        };
        log(`Register validation: ${lastRegisterError.message}`, "❌");
        onStateChange(publicHostState());
        return {
          ok: false,
          error: lastRegisterError,
          pairingError: lastRegisterError,
          shouldConsume: false,
        };
      }
      throw err;
    }

    if (!result.ok && result.conflict) {
      hostConflict = result.conflict;
      lastRegisterError = {
        code: result.conflict.code,
        message: result.conflict.message,
      };
      policy.revoke("print_host_already_configured");
      consumeEnabled = false;
      persistHostFlags();
      onStateChange(publicHostState());
      log(`Print host conflict: ${result.conflict.message}`, "⚠️");
      return { ok: false, conflict: result.conflict, shouldConsume: false };
    }

    if (!result.ok) {
      lastRegisterError = result.error || {
        code: "REGISTER_FAILED",
        message: "Register failed",
      };
      log(
        `Register failed: ${lastRegisterError.code || ""} ${lastRegisterError.message || "unknown"}`.trim(),
        "❌"
      );
      onStateChange(publicHostState());
      return { ok: false, error: result.error, shouldConsume: false };
    }

    hostConflict = null;
    lastRegisterError = null;
    needsPairing = false;
    if (result.token) {
      writeConfig({ agent_token: result.token });
      api.setToken(result.token);
    }
    const patch = {};
    if (result.heartbeat_interval_seconds) {
      patch.heartbeat_interval_seconds = result.heartbeat_interval_seconds;
      patch.heartbeat_ttl_seconds = result.heartbeat_ttl_seconds || 90;
    }
    if (result.branch_id != null) {
      patch.branch_id = String(result.branch_id);
    }
    if (result.pdf_host) {
      patch.pdf_host = result.pdf_host;
    }
    // Persist rabbit.queue / durable / arguments and apply broker creds when present
    const rabbitConfig =
      result.rabbitConfig ||
      normalizeRabbitConfig(result.rabbit, result.branch_id || branchId || cfg.branch_id);
    Object.assign(patch, rabbitConfigToPersistPatch(rabbitConfig));
    if (Object.keys(patch).length) writeConfig(patch);
    if (rabbitConfig.hasBrokerCreds) {
      log(
        `Applied Rabbit settings from register (${rabbitConfig.host || "host?"}:${rabbitConfig.port || "?"}, queue ${rabbitConfig.queue}).`,
        "⚙️"
      );
    } else if (rabbitConfig.queue) {
      log(`Using print queue ${rabbitConfig.queue} (from register / default).`, "ℹ️");
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
      rabbitConfig,
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
      if (handleAuthFailure(result, "heartbeat_unauthorized")) {
        return {
          ok: false,
          authError: true,
          needsPairing: true,
          error: lastRegisterError,
          shouldConsume: false,
        };
      }
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
      await api.deregister({ reason: "explicit_deregister" });
    } catch (_) {}
    // Explicit deregister revokes token and clears host on server — mirror locally.
    clearLocalAuth("deregister");
    return { ok: true, needsPairing: true };
  }

  /**
   * Resume existing session via heartbeat when token is present; otherwise register.
   * Restart with same app_id + valid token must not call register again.
   */
  async function ensureSession({ branchId } = {}) {
    const cfg = readConfig();
    api.setApiBase(cfg.agent_api_base || "");
    const token = api.getToken() || cfg.agent_token || "";
    if (token && String(token).trim()) {
      api.setToken(token);
      const hb = await heartbeat({ branchId });
      if (hb.authError || hb.needsPairing) {
        return {
          ok: false,
          resumed: false,
          needsPairing: true,
          error: hb.error,
          shouldConsume: false,
        };
      }
      if (!hb.ok && hb.skipped) {
        return { ok: false, resumed: false, skipped: true, shouldConsume: false };
      }
      if (!hb.ok) {
        return {
          ok: false,
          resumed: true,
          error: hb.error,
          shouldConsume: consumeEnabled,
        };
      }
      return {
        ok: true,
        resumed: true,
        shouldConsume: consumeEnabled,
        promoted: hb.promoted,
        revoked: hb.revoked,
        pending_job_count: hb.pending_job_count,
        flushPending: hb.flushPending || flushPending,
      };
    }
    // No token — must register with pairing code
    const reg = await registerAsHost({ branchId });
    return { ...reg, resumed: false };
  }

  const sleep =
    typeof deps.sleep === "function"
      ? deps.sleep
      : (ms) => new Promise((r) => setTimeout(r, ms));
  const SYNC_CONFLICT_MAX_ATTEMPTS = 3;

  /**
   * Upsert printers. On 409 SYNC_CONFLICT (v1.4), retry ~3 times with short
   * jittered backoff, then fall through so the next poll/heartbeat can retry.
   * Distinguished from PRINT_HOST_ALREADY_CONFIGURED by error.code.
   */
  async function syncPrintersToServer({ branchId } = {}) {
    const cfg = readConfig();
    if (!api.getToken()) return { ok: false, skipped: true };
    let last = null;
    for (let attempt = 1; attempt <= SYNC_CONFLICT_MAX_ATTEMPTS; attempt++) {
      const result = await api.syncPrinters({
        appId,
        branchId: branchId || cfg.branch_id,
        printers: printers.toSyncPayload(),
      });
      last = result;
      if (handleAuthFailure(result, "sync_unauthorized")) {
        return {
          ok: false,
          authError: true,
          needsPairing: true,
          error: lastRegisterError,
        };
      }
      if (result.ok) {
        if (Array.isArray(result.printers) && result.printers.length) {
          printers.applyServerSync(result.printers);
          persistHostFlags();
          onStateChange(publicHostState());
        }
        return result;
      }
      const isSyncConflict =
        result.syncConflict === true ||
        result.code === ERROR_CODES.SYNC_CONFLICT;
      if (!isSyncConflict) return result;
      if (attempt >= SYNC_CONFLICT_MAX_ATTEMPTS) {
        try {
          log(
            `Printers sync SYNC_CONFLICT after ${attempt} attempts — will retry on next poll/heartbeat.`,
            "⚠️"
          );
        } catch (_) {}
        return {
          ...result,
          syncConflict: true,
          retriesExhausted: true,
          attempts: attempt,
        };
      }
      const delay = syncConflictBackoffMs(attempt);
      try {
        log(
          `Printers sync SYNC_CONFLICT (attempt ${attempt}/${SYNC_CONFLICT_MAX_ATTEMPTS}) — retry in ${delay}ms.`,
          "⚠️"
        );
      } catch (_) {}
      await sleep(delay);
    }
    return last || { ok: false, syncConflict: true, retriesExhausted: true };
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
    const opts = resolveQueueDeclareOptions(readConfig());
    return opts.arguments || { "x-single-active-consumer": true };
  }

  function rabbitQueueDeclareOptions() {
    return resolveQueueDeclareOptions(readConfig());
  }

  function rabbitQueueName(branchId) {
    const cfg = readConfig();
    return resolveQueueName(cfg, branchId || cfg.branch_id);
  }

  /** Consume options: exclusive must be false; prefetch is set on the channel. */
  function rabbitConsumeOptions() {
    const cfg = readConfig();
    const exclusive =
      cfg.rabbit_consume_exclusive != null
        ? Boolean(cfg.rabbit_consume_exclusive)
        : ASSUMPTIONS.consumeExclusive;
    return {
      exclusive: exclusive === true,
      noAck: false,
    };
  }

  function rabbitPrefetch() {
    const cfg = readConfig();
    const n = Number(cfg.rabbit_prefetch);
    return Number.isFinite(n) && n > 0 ? n : ASSUMPTIONS.prefetch;
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
    clearLocalAuth,
    registerAsHost,
    ensureSession,
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
    rabbitQueueDeclareOptions,
    rabbitQueueName,
    rabbitConsumeOptions,
    rabbitPrefetch,
    get flushPending() {
      return flushPending;
    },
    get hostConflict() {
      return hostConflict;
    },
    get lastRegisterError() {
      return lastRegisterError;
    },
    get needsPairing() {
      return needsPairing;
    },
  };
}

module.exports = { createStationPrintingController };
