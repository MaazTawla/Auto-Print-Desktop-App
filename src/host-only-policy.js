/**
 * HostOnlyPolicy (Option A) — consume the branch print queue only while
 * this agent is the designated print host. Honour host_epoch revoke.
 */

"use strict";

/**
 * @typedef {{ isPrintHost: boolean, hostEpoch: number, knownEpoch?: number|null }} HostPolicyState
 */

function createHostOnlyPolicy(initial = {}) {
  let isPrintHost = Boolean(initial.isPrintHost);
  let hostEpoch = Number.isFinite(Number(initial.hostEpoch))
    ? Number(initial.hostEpoch)
    : 1;
  /** Locally observed epoch from last authoritative server response. */
  let knownEpoch = Number.isFinite(Number(initial.knownEpoch))
    ? Number(initial.knownEpoch)
    : hostEpoch;

  function snapshot() {
    return {
      isPrintHost,
      hostEpoch,
      knownEpoch,
      shouldConsume: shouldConsume(),
    };
  }

  function shouldConsume() {
    return isPrintHost === true;
  }

  /**
   * Apply register/heartbeat fields from the server.
   * Returns { changed, revoked, promoted, shouldConsume }.
   */
  function applyServerState({ is_print_host, host_epoch } = {}) {
    const nextHost = Boolean(is_print_host);
    const nextEpoch = Number.isFinite(Number(host_epoch))
      ? Number(host_epoch)
      : hostEpoch;

    const wasHost = isPrintHost;
    const prevEpoch = knownEpoch;

    const epochBumped = nextEpoch > prevEpoch;
    const revoked =
      (wasHost && !nextHost) || (wasHost && epochBumped && !nextHost) || (wasHost && epochBumped && nextHost === false);
    // Epoch increase while we thought we were host always means revoke until confirmed host again
    const epochRevoke = wasHost && epochBumped && nextEpoch !== prevEpoch;
    const promoted = !wasHost && nextHost;

    isPrintHost = nextHost;
    hostEpoch = nextEpoch;
    knownEpoch = nextEpoch;

    const changed = wasHost !== nextHost || prevEpoch !== nextEpoch;
    return {
      changed,
      revoked: revoked || epochRevoke || (wasHost && !nextHost),
      promoted,
      shouldConsume: shouldConsume(),
      snapshot: snapshot(),
    };
  }

  /**
   * Force local revoke (e.g. after Change print host detected offline).
   */
  function revoke(reason) {
    const wasHost = isPrintHost;
    isPrintHost = false;
    return {
      changed: wasHost,
      revoked: wasHost,
      reason: reason || "revoked",
      shouldConsume: false,
      snapshot: snapshot(),
    };
  }

  /**
   * Decide what to do with an inbound Rabbit message.
   * Returns { action: 'print'|'nack'|'drop', reason }.
   * - nack without requeue for policy failures (stray after revoke).
   */
  function decideMessage(msg, opts = {}) {
    if (!shouldConsume()) {
      return { action: "nack", reason: "not_print_host" };
    }
    const msgEpoch =
      msg && msg.host_epoch != null && Number.isFinite(Number(msg.host_epoch))
        ? Number(msg.host_epoch)
        : null;
    if (msgEpoch != null && msgEpoch !== hostEpoch) {
      // Stale generation — do not print; nack without requeue
      return { action: "nack", reason: "host_epoch_mismatch" };
    }
    if (opts.requirePrinterExternalId && !(msg && msg.printer_external_id)) {
      // v2 jobs should carry a printer; allow legacy without if configured
      if ((msg && msg.schema_version) >= 2) {
        return { action: "nack", reason: "missing_printer_external_id" };
      }
    }
    return { action: "print", reason: null };
  }

  return {
    shouldConsume,
    applyServerState,
    revoke,
    decideMessage,
    snapshot,
    get isPrintHost() {
      return isPrintHost;
    },
    get hostEpoch() {
      return hostEpoch;
    },
  };
}

module.exports = { createHostOnlyPolicy };
