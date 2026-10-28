"use strict";

/**
 * Sync server branch_id into in-memory state + persisted config without
 * reconnecting Rabbit. Used inside startRabbit so we never re-enter
 * rabbitStartChain via applyBranchId → startRabbit (Desktop r10 H1 deadlock).
 *
 * @returns {{ changed: boolean, branchId?: string, channel?: string }}
 */
function syncBranchIdFromServer(state, serverBranch, deps) {
  const next = serverBranch != null ? String(serverBranch).trim() : "";
  if (!next) return { changed: false };
  if (next === String(state.branchId || "").trim()) return { changed: false };
  state.branchId = next;
  const template =
    typeof deps.getRoutingKeyTemplate === "function"
      ? deps.getRoutingKeyTemplate()
      : deps.routingKeyTemplate || "orders.{branch_id}";
  const channel =
    typeof deps.resolveRoutingKey === "function"
      ? deps.resolveRoutingKey(template, next)
      : "";
  state.channel = channel;
  if (typeof deps.saveUserConfig === "function") {
    deps.saveUserConfig({ branch_id: next });
  }
  return { changed: true, branchId: next, channel };
}

/**
 * applyBranchId must not await startRabbit while a start is already running
 * on rabbitStartChain (nested await deadlocks the serializer).
 */
function shouldReconnectAfterBranchApply(rabbitStarting) {
  return !rabbitStarting;
}

/**
 * Minimal serializer matching main.js rabbitStartChain semantics.
 * Nested runExclusive from inside an active run never settles if awaited —
 * callers must sync state instead of re-entering.
 */
function createRabbitStartSerializer() {
  let chain = Promise.resolve();
  let starting = false;
  return {
    get starting() {
      return starting;
    },
    runExclusive(fn) {
      const run = async () => {
        starting = true;
        try {
          return await fn();
        } finally {
          starting = false;
        }
      };
      const next = chain.then(run, run);
      chain = next.catch(() => {});
      return next;
    },
  };
}

module.exports = {
  syncBranchIdFromServer,
  shouldReconnectAfterBranchApply,
  createRabbitStartSerializer,
};
