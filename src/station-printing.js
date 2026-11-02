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
  rabbitConnectionFingerprint,
  resolveQueueDeclareOptions,
  resolveQueueName,
  normalizeRabbitConfig,
  normalizeAgentApiBase,
} = require("./agent-contract");
const {
  configHash: printerListConfigHash,
  statusFingerprint: printerStatusFingerprint,
  shouldSkipUnchanged: shouldSkipPrinterListSync,
  shouldLogHeartbeatFailure,
  heartbeatFailureRetryMs,
} = require("./printer-list-sync-policy");

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
      waitingForRabbitCreds: Boolean(
        policy.isPrintHost &&
          !(readConfig().rabbit_host && String(readConfig().rabbit_host).trim())
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
    const normalized = normalizeAgentApiBase(base);
    api.setApiBase(normalized);
    writeConfig({ agent_api_base: normalized });
  }

  function setDeviceLabel(label) {
    writeConfig({ device_label: String(label || "").trim() });
  }

  /** Atomic wipe: rabbit_* + rabbit_version together (contract v1.8 §6). Never wipe creds but keep version. */
  function dropBrokerCredentialsPatch() {
    return {
      rabbit_host: "",
      rabbit_port: "",
      rabbit_username: "",
      rabbit_password: "",
      rabbit_tls: false,
      rabbit_version: "",
      last_server_rabbit: null,
      rabbit_vhost: "/",
      rabbit_exchange: "",
      rabbit_routing_key: "",
    };
  }

  /** Contract §4: send rabbit_version only while host AND holding broker creds. */
  function rabbitVersionToSendOnHeartbeat(cfg, isHost) {
    if (!isHost) return undefined;
    const hasBroker = Boolean(cfg.rabbit_host && String(cfg.rabbit_host).trim());
    if (!hasBroker) return undefined;
    const v = cfg.rabbit_version;
    if (v == null || String(v).trim() === "") return undefined;
    return String(v).trim();
  }

  function setPairingCode(code) {
    writeConfig({ pairing_code: String(code || "").trim() });
  }

  /**
   * L13: when Advanced override turns off, restore last server rabbit and
   * return whether broker fingerprint changed (caller should reconnect).
   */
  function setRabbitManualOverride(enabled) {
    const on = Boolean(enabled);
    const cfg = readConfig();
    if (on) {
      writeConfig({ rabbit_manual_override: true });
      log(
        "Advanced: manual RabbitMQ override ON — server register will not overwrite broker fields.",
        "⚙️"
      );
      onStateChange(publicHostState());
      return { ok: true, rabbitManualOverride: true, rabbitChanged: false };
    }
    const beforeFp = rabbitConnectionFingerprint(cfg);
    const snapshot = cfg.last_server_rabbit;
    const patch = { rabbit_manual_override: false };
    if (snapshot && typeof snapshot === "object") {
      const rabbitConfig = normalizeRabbitConfig(snapshot, cfg.branch_id, {
        apiBaseUrl: cfg.agent_api_base || "",
        manualOverride: false,
      });
      Object.assign(patch, rabbitConfigToPersistPatch(rabbitConfig, { manualOverride: false }));
      if (rabbitConfig.hostRewriteNote) {
        log(rabbitConfig.hostRewriteNote, "ℹ️");
      }
      log(
        `Override off — restored Rabbit settings from last server payload (${rabbitConfig.host || "host?"}:${rabbitConfig.port || "?"}).`,
        "⚙️"
      );
    } else {
      log(
        "Advanced: manual RabbitMQ override OFF — broker settings will follow the server on next Connect/heartbeat.",
        "⚙️"
      );
    }
    writeConfig(patch);
    const afterFp = rabbitConnectionFingerprint(readConfig());
    const rabbitChanged = beforeFp !== afterFp;
    onStateChange(publicHostState());
    return { ok: true, rabbitManualOverride: false, rabbitChanged };
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
      ...dropBrokerCredentialsPatch(),
      agent_token: "",
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
      writeConfig(dropBrokerCredentialsPatch());
      persistHostFlags();
      onStateChange(publicHostState());
      log(`Print host conflict: ${result.conflict.message}`, "⚠️");
      log("Dropped local Rabbit credentials (not print host).", "ℹ️");
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
    // v1.8: rabbit_version null → drop creds; missing key → keep; set → store.
    // Full rabbit only when present (never treat absence of rabbit as wipe).
    const beforeFp = rabbitConnectionFingerprint(cfg);
    const manualOverride = Boolean(cfg.rabbit_manual_override);
    let rabbitConfig = null;
    const versionAction = result.rabbit_version_action || "keep";
    // §6: null version OR not print host → atomic wipe (version + rabbit together).
    const wipeBroker = versionAction === "clear" || !result.is_print_host;
    if (wipeBroker) {
      Object.assign(patch, dropBrokerCredentialsPatch());
      if (versionAction === "clear" || !result.is_print_host) {
        log(
          result.is_print_host
            ? "Server cleared Rabbit credentials (rabbit_version: null)."
            : "Not print host — wiped local Rabbit credentials and version (contract §6).",
          "ℹ️"
        );
      }
    } else {
      // §5: rabbit present → replace config; §2: persist version when set/host.
      if (result.rabbit && typeof result.rabbit === "object") {
        rabbitConfig = normalizeRabbitConfig(
          result.rabbit,
          result.branch_id || branchId || cfg.branch_id,
          { apiBaseUrl: cfg.agent_api_base || "", manualOverride }
        );
        Object.assign(
          patch,
          rabbitConfigToPersistPatch(rabbitConfig, { manualOverride })
        );
        patch.last_server_rabbit = result.rabbit;
      }
      if (result.rabbit_version) {
        patch.rabbit_version = String(result.rabbit_version).trim();
      }
    }
    // L2: never leave pairing code on disk after a successful register.
    patch.pairing_code = "";
    if (Object.keys(patch).length) writeConfig(patch);
    const afterCfg = readConfig();
    const afterFp = rabbitConnectionFingerprint(afterCfg);
    if (rabbitConfig && rabbitConfig.hostRewriteNote) {
      log(rabbitConfig.hostRewriteNote, "ℹ️");
    }
    if (rabbitConfig) {
      if (manualOverride) {
        log(
          "Register rabbit payload received; Advanced manual override is on — keeping local broker settings.",
          "ℹ️"
        );
      } else if (rabbitConfig.hasBrokerCreds) {
        log(
          `Applied Rabbit settings from register (${rabbitConfig.host || "host?"}:${rabbitConfig.port || "?"}, queue ${rabbitConfig.queue}).`,
          "⚙️"
        );
      } else if (rabbitConfig.queue) {
        log(`Using print queue ${rabbitConfig.queue} (from register / default).`, "ℹ️");
      }
    }
    const rabbitChanged = beforeFp !== afterFp;
    const applied = policy.applyServerState({
      is_print_host: result.is_print_host,
      host_epoch: result.host_epoch,
    });
    // Host-only consumer: need is_print_host AND broker creds.
    const hasBroker =
      Boolean(afterCfg.rabbit_host && String(afterCfg.rabbit_host).trim()) ||
      Boolean(rabbitConfig && rabbitConfig.hasBrokerCreds);
    const waitingForCreds = Boolean(result.is_print_host && !hasBroker);
    if (waitingForCreds) {
      consumeEnabled = false;
      log(
        "Print host confirmed — waiting for Rabbit credentials from server (next heartbeat).",
        "ℹ️"
      );
    } else {
      consumeEnabled = applied.shouldConsume && hasBroker && versionAction !== "clear";
    }
    if (applied.promoted && consumeEnabled) flushPending = true;
    if (!result.is_print_host) {
      log(
        "Not the print host — Rabbit credentials are only sent to the print host. Consumer stays idle.",
        "ℹ️"
      );
    }
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
      rabbitChanged: Boolean(rabbitChanged),
      waitingForRabbitCreds: waitingForCreds,
      branch_id: result.branch_id != null ? String(result.branch_id) : afterCfg.branch_id || null,
    };
  }

  const sleep =
    typeof deps.sleep === "function"
      ? deps.sleep
      : (ms) => new Promise((r) => setTimeout(r, ms));
  const nowFn = typeof deps.now === "function" ? deps.now : () => Date.now();
  const SYNC_CONFLICT_MAX_ATTEMPTS = 3;
  /** Cap gated printer-upsert retries+backoff well under 60s (and under 90s offline TTL). */
  const PRINTER_SYNC_BUDGET_MS = 45000;

  /**
   * Single-flight gate so printers/sync and heartbeat *printer upsert* never overlap
   * (Rabbit connect starts HB before awaiting sync). Liveness pings stay outside this gate.
   */
  let printerSyncGate = Promise.resolve();
  let printerSyncInFlight = 0;

  function withPrinterSyncSingleFlight(task) {
    const run = printerSyncGate.then(
      () => {
        printerSyncInFlight += 1;
        return Promise.resolve()
          .then(() => task())
          .finally(() => {
            printerSyncInFlight = Math.max(0, printerSyncInFlight - 1);
          });
      },
      () => {
        printerSyncInFlight += 1;
        return Promise.resolve()
          .then(() => task())
          .finally(() => {
            printerSyncInFlight = Math.max(0, printerSyncInFlight - 1);
          });
      }
    );
    printerSyncGate = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  function isPrinterSyncInFlight() {
    return printerSyncInFlight > 0;
  }

  function isSyncConflictResult(result) {
    return (
      Boolean(result) &&
      (result.syncConflict === true || result.code === ERROR_CODES.SYNC_CONFLICT)
    );
  }

  /**
   * Shared SYNC_CONFLICT retry (contract v1.4 / Android SyncConflictPolicy):
   * ~3 jittered attempts, then defer. Total time (attempts + backoff) capped by budgetMs.
   * attemptFn(attempt, { timeoutMs, remainingMs })
   */
  async function withSyncConflictRetries(label, attemptFn, opts = {}) {
    const budgetMs =
      opts.budgetMs != null ? Number(opts.budgetMs) : PRINTER_SYNC_BUDGET_MS;
    const t0 = nowFn();
    let last = null;
    for (let attempt = 1; attempt <= SYNC_CONFLICT_MAX_ATTEMPTS; attempt++) {
      const elapsed = Math.max(0, nowFn() - t0);
      const remaining = Math.max(0, budgetMs - elapsed);
      if (remaining < 50) {
        try {
          log(
            `${label} SYNC_CONFLICT budget exhausted after ${attempt - 1} attempt(s) — defer.`,
            "⚠️"
          );
        } catch (_) {}
        return {
          ...(last || { ok: false, syncConflict: true }),
          syncConflict: true,
          retriesExhausted: true,
          budgetExceeded: true,
          attempts: Math.max(0, attempt - 1),
        };
      }
      const timeoutMs = Math.min(20000, remaining);
      const result = await attemptFn(attempt, { timeoutMs, remainingMs: remaining });
      last = result;
      if (!result || result.ok || !isSyncConflictResult(result)) {
        return result;
      }
      if (attempt >= SYNC_CONFLICT_MAX_ATTEMPTS) {
        try {
          log(
            `${label} SYNC_CONFLICT after ${attempt} attempts — will retry on next poll/heartbeat.`,
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
      if (nowFn() - t0 + delay >= budgetMs) {
        try {
          log(
            `${label} SYNC_CONFLICT — backoff would exceed budget; defer.`,
            "⚠️"
          );
        } catch (_) {}
        return {
          ...result,
          syncConflict: true,
          retriesExhausted: true,
          budgetExceeded: true,
          attempts: attempt,
        };
      }
      try {
        log(
          `${label} SYNC_CONFLICT (attempt ${attempt}/${SYNC_CONFLICT_MAX_ATTEMPTS}) — retry in ${delay}ms.`,
          "⚠️"
        );
      } catch (_) {}
      await sleep(delay);
    }
    return last || { ok: false, syncConflict: true, retriesExhausted: true };
  }

  /**
   * Heartbeat split (r6 M1 / r7 L1–L2):
   * 1) Ungated liveness ping with printers: [] (contract: empty OK if unchanged) —
   *    never waits on the sync gate or sync retries, so 30s ticks beat the 90s offline TTL.
   *    In-flight guard: skip a tick if the previous liveness ping is still in flight.
   * 2) Gated full printer upsert (preferred snapshot) with SYNC_CONFLICT retries,
   *    serialized with printers/sync and bounded by PRINTER_SYNC_BUDGET_MS.
   *    Timeout/errors after liveness are caught and logged (no unhandled rejection).
   */
  let livenessInFlight = false;
  let consecutiveHbFailures = 0;

  function isLivenessInFlight() {
    return livenessInFlight;
  }

  async function heartbeat({ branchId } = {}) {
    const cfg = readConfig();
    if (!api.getToken() || !(cfg.agent_api_base || "").trim()) {
      return { ok: false, skipped: true, shouldConsume: consumeEnabled };
    }
    // r7 L1: never overlap ungated liveness pings — skip this tick.
    if (livenessInFlight) {
      return {
        ok: true,
        skipped: true,
        livenessSkipped: true,
        shouldConsume: consumeEnabled,
      };
    }
    api.setApiBase(cfg.agent_api_base || "");
    const bid = branchId || cfg.branch_id;

    // 1) Ungated liveness — outside the printer-sync gate.
    livenessInFlight = true;
    let live;
    try {
      live = await api.heartbeat({
        appId,
        branchId: bid,
        printers: [],
        rabbitVersion: rabbitVersionToSendOnHeartbeat(
          cfg,
          Boolean(cfg.is_print_host)
        ),
      });
    } finally {
      livenessInFlight = false;
    }
    lastHeartbeatAt = new Date().toISOString();

    if (!live || !live.ok) {
      consecutiveHbFailures += 1;
      if (live && handleAuthFailure(live, "heartbeat_unauthorized")) {
        consecutiveHbFailures = 0;
        return {
          ok: false,
          authError: true,
          needsPairing: true,
          error: lastRegisterError,
          shouldConsume: false,
        };
      }
      if (shouldLogHeartbeatFailure(consecutiveHbFailures)) {
        try {
          const msg =
            (live && live.error && live.error.message) ||
            (live && live.error) ||
            "Heartbeat failed";
          log(`Heartbeat liveness failed: ${msg}`, "⚠️");
        } catch (_) {}
      }
      onStateChange(publicHostState());
      return {
        ok: false,
        error:
          (live && live.error) || {
            code: "HEARTBEAT_FAILED",
            message: "Heartbeat failed",
          },
        syncConflict: Boolean(live && live.syncConflict),
        retriesExhausted: Boolean(live && live.retriesExhausted),
        shouldConsume: consumeEnabled,
        consecutiveHbFailures,
        retrySoonMs: heartbeatFailureRetryMs(consecutiveHbFailures),
      };
    }
    if (consecutiveHbFailures > 0) {
      try {
        log(
          `Heartbeat recovered after ${consecutiveHbFailures} failure(s).`,
          "✅"
        );
      } catch (_) {}
      consecutiveHbFailures = 0;
    }

    const applied = policy.applyServerState({
      is_print_host: live.is_print_host,
      host_epoch: live.host_epoch,
    });
    consumeEnabled = applied.shouldConsume;
    const versionAction = live.rabbit_version_action || "keep";
    // §6: null version OR not print host OR revoke → atomic wipe (version + rabbit + disconnect).
    const wipeBroker =
      versionAction === "clear" || !live.is_print_host || applied.revoked;
    if (wipeBroker) {
      writeConfig(dropBrokerCredentialsPatch());
      consumeEnabled = false;
      if (versionAction === "clear") {
        log(
          "Server sent rabbit_version: null — dropped local Rabbit credentials and version; consumer idle.",
          "⚠️"
        );
      } else if (!live.is_print_host || applied.revoked) {
        log(
          `Not print host (epoch ${live.host_epoch}) — wiped Rabbit credentials and version; consumer idle.`,
          "⚠️"
        );
      }
    }

    // §5: rabbit present → replace config + version + reconnect. Never wipe on mere absence.
    let rabbitChanged = false;
    const hbPatch = {};
    if (!wipeBroker) {
      if (live.rabbit_version) {
        hbPatch.rabbit_version = String(live.rabbit_version).trim();
      }
      if (live.rabbit && typeof live.rabbit === "object") {
        const beforeFp = rabbitConnectionFingerprint(cfg);
        const manualOverride = Boolean(cfg.rabbit_manual_override);
        const rabbitConfig = normalizeRabbitConfig(live.rabbit, bid || cfg.branch_id, {
          apiBaseUrl: cfg.agent_api_base || "",
          manualOverride,
        });
        Object.assign(hbPatch, rabbitConfigToPersistPatch(rabbitConfig, { manualOverride }));
        hbPatch.last_server_rabbit = live.rabbit;
        if (rabbitConfig.hostRewriteNote) {
          log(rabbitConfig.hostRewriteNote, "ℹ️");
        }
        if (!manualOverride) {
          log(
            `Applied Rabbit settings from heartbeat (${rabbitConfig.host || "host?"}:${rabbitConfig.port || "?"}).`,
            "⚙️"
          );
        }
        writeConfig(hbPatch);
        const afterFp = rabbitConnectionFingerprint(readConfig());
        rabbitChanged = beforeFp !== afterFp;
        if (rabbitChanged) {
          log(
            "Rabbit broker config changed — reconnecting consumer (finish in-flight, no double ack).",
            "🔄"
          );
        }
      } else if (Object.keys(hbPatch).length) {
        writeConfig(hbPatch);
      }
    }

    // Host-only consume: need broker. Missing rabbit key does not wipe prior creds.
    let waitingForCreds = false;
    {
      const cfgNow = readConfig();
      const hasBroker = Boolean(
        cfgNow.rabbit_host && String(cfgNow.rabbit_host).trim()
      );
      if (wipeBroker) {
        consumeEnabled = false;
      } else if (applied.shouldConsume && !hasBroker) {
        consumeEnabled = false;
        waitingForCreds = Boolean(live.is_print_host);
        if (waitingForCreds) {
          log(
            "Print host active — waiting for Rabbit credentials from server (next heartbeat).",
            "ℹ️"
          );
        }
      } else {
        consumeEnabled = applied.shouldConsume && hasBroker;
      }
      if (applied.promoted && consumeEnabled) flushPending = true;
    }

    persistHostFlags();
    onStateChange(publicHostState());

    // Printer-list config sync is NOT on the heartbeat cadence.
    // Host online status is kept by the ungated printers:[] liveness ping above.
    // List sync runs on connect / add-edit-remove (hash-skipped). Status uses
    // pushPrinterStatusesIfChanged().
    const printerUpsert = null;

    return {
      ok: true,
      shouldConsume: consumeEnabled,
      revoked: wipeBroker,
      brokerWiped: wipeBroker,
      promoted: applied.promoted,
      pending_job_count: live.pending_job_count,
      flushPending,
      rabbitChanged: Boolean(rabbitChanged),
      waitingForRabbitCreds: waitingForCreds,
      printerUpsert,
      syncConflict: false,
      retriesExhausted: false,
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

  /**
   * Upsert printers via POST printers/sync. Single-flight with heartbeat.
   * On 409 SYNC_CONFLICT (v1.4), retry ~3 times with short jittered backoff,
   * then defer to the next poll/heartbeat. Not PRINT_HOST_ALREADY_CONFIGURED.
   */
  async function syncPrintersToServer({ branchId, force = false } = {}) {
    const cfg = readConfig();
    if (!api.getToken()) return { ok: false, skipped: true };
    const payload = printers.toSyncPayload();
    const hash = printerListConfigHash(payload);
    const lastHash = cfg.last_printer_list_sync_hash || "";
    if (
      !force &&
      shouldSkipPrinterListSync(hash, lastHash, {
        forceEmpty: false,
        pendingEmpty: Boolean(cfg.pending_empty_printer_sync),
      })
    ) {
      return { ok: true, skipped: true, unchanged: true };
    }
    return withPrinterSyncSingleFlight(() =>
      withSyncConflictRetries("Printers sync", async (_attempt, { timeoutMs }) => {
        const result = await api.syncPrinters({
          appId,
          branchId: branchId || cfg.branch_id,
          printers: payload,
          timeout: timeoutMs,
        });
        if (handleAuthFailure(result, "sync_unauthorized")) {
          return {
            ok: false,
            authError: true,
            needsPairing: true,
            error: lastRegisterError,
            // not a sync conflict — stop retries
            code: (lastRegisterError && lastRegisterError.code) || "UNAUTHORIZED",
          };
        }
        if (result.ok) {
          if (Array.isArray(result.printers) && result.printers.length) {
            printers.applyServerSync(result.printers);
            persistHostFlags();
            onStateChange(publicHostState());
          }
          // Hash the post-apply payload so fields the server echoes (e.g. is_default)
          // cannot invalidate the next skip check (M2).
          const hashAfter = printerListConfigHash(printers.toSyncPayload());
          writeConfig({ last_printer_list_sync_hash: hashAfter });
          try {
            log(
              `Synced ${payload.length} printer(s) to server` +
                (Array.isArray(result.printers) && result.printers.length
                  ? ` (${result.printers.length} with server ids).`
                  : "."),
              "📡"
            );
          } catch (_) {}
        } else {
          try {
            const msg =
              (result && result.error && result.error.message) ||
              (result && result.error) ||
              "Printer sync failed";
            log(`Printer sync failed: ${msg}`, "⚠️");
          } catch (_) {}
        }
        return result;
      })
    );
  }

  /**
   * Push per-printer status immediately when the local status fingerprint changes.
   */
  async function pushPrinterStatusesIfChanged() {
    const cfg = readConfig();
    if (!api.getToken()) return { ok: false, skipped: true };
    const payload = printers.toSyncPayload();
    if (!payload.length) return { ok: true, skipped: true };
    const fp = printerStatusFingerprint(payload);
    if (fp && fp === (cfg.last_printer_status_fingerprint || "")) {
      return { ok: true, skipped: true, unchanged: true };
    }
    const results = [];
    for (const p of payload) {
      const pathId = p.id || p.external_id;
      if (!pathId) continue;
      try {
        const r = await api.reportPrinterStatus(pathId, {
          status: p.status || "online",
          status_detail: p.status_detail || null,
          external_id: p.external_id,
        });
        results.push(r);
        if (r && r.ok) {
          try {
            log(
              `Printer status ${p.external_id} → ${p.status || "online"}` +
                (p.status_detail ? ` (${p.status_detail})` : ""),
              "📡"
            );
          } catch (_) {}
        } else {
          try {
            log(
              `Printer status push failed for ${p.external_id}: ` +
                ((r && r.error && r.error.message) || (r && r.error) || "error"),
              "⚠️"
            );
          } catch (_) {}
        }
      } catch (err) {
        try {
          log(
            `Printer status push failed for ${p.external_id}: ${err.message || err}`,
            "⚠️"
          );
        } catch (_) {}
      }
    }
    writeConfig({ last_printer_status_fingerprint: fp });
    return { ok: true, results };
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
   * Upsert a managed printer. When replaceExternalId differs from the new
   * external_id (LAN host/port edit), migrate aliases / server_id and reject
   * collisions with another printer's eid (M1/M2).
   */
  function upsertManagedPrinter(printer, opts = {}) {
    const replaceId = String(opts.replaceExternalId || "").trim();
    const rowIn = printer && typeof printer === "object" ? printer : {};
    const externalId = String(rowIn.external_id || rowIn.externalId || "").trim();
    if (!externalId) return { ok: false, error: "Missing printer external_id." };
    if (replaceId && replaceId.toLowerCase() !== externalId.toLowerCase()) {
      const replaced = printers.replaceExternalId(replaceId, {
        ...rowIn,
        external_id: externalId,
      });
      if (!replaced.ok) return replaced;
      persistHostFlags();
      onStateChange(publicHostState());
      return replaced;
    }
    const saved = printers.upsert({
      ...rowIn,
      external_id: externalId,
    });
    persistHostFlags();
    onStateChange(publicHostState());
    return { ok: true, printer: saved };
  }

  /** Remove locally and persist; caller should syncPrintersToServer. */
  function removeManagedPrinter(externalId) {
    const id = String(externalId || "").trim();
    if (!id) return { ok: false, error: "Missing printer external_id." };
    const removed = printers.remove(id);
    if (!removed) return { ok: false, error: "Printer not found." };
    persistHostFlags();
    onStateChange(publicHostState());
    return { ok: true, removed };
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
    setRabbitManualOverride,
    clearHostConflict,
    clearLocalAuth,
    registerAsHost,
    ensureSession,
    heartbeat,
    deregister,
    syncPrintersToServer,
    pushPrinterStatusesIfChanged,
    isPrinterSyncInFlight,
    isLivenessInFlight,
    syncWindowsPrinters,
    setDefaultPrinter,
    upsertManagedPrinter,
    removeManagedPrinter,
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
