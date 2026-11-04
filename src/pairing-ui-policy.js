/**
 * Renderer-side pairing UI policy (loaded by index.html and by tests).
 * - Pairing/register errors show only the friendly message (no "CODE: " prefix).
 * - R4-I3 (Android parity): clear the pairing-code field once when the app newly
 *   asks for fresh pairing (false → true), never again while the prompt stays up,
 *   and never while the user is typing in it.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.PairingUiPolicy = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  /** Fresh-pairing prompt: app asks for pairing and no code is saved. */
  function isFreshPairingPrompt(sp) {
    return Boolean(sp && sp.needsPairing && !sp.pairingCodeConfigured);
  }

  function shouldClearField(wasFreshPrompt, isFreshPrompt, userEditing) {
    return !wasFreshPrompt && Boolean(isFreshPrompt) && !userEditing;
  }

  /**
   * Stateful tracker: call update() on every render; returns true exactly once
   * per false → true transition. If the user is typing at that moment, the clear
   * is skipped (not deferred), so their input is never wiped.
   */
  function createFieldClearTracker() {
    let wasFresh = false;
    return {
      update(sp, userEditing) {
        const fresh = isFreshPairingPrompt(sp);
        const clear = shouldClearField(wasFresh, fresh, userEditing);
        wasFresh = fresh;
        return clear;
      },
    };
  }

  /** Friendly text only; the code is kept for logs, never prefixed in the UI. */
  function errorText(err, fallback) {
    if (err && typeof err === "object" && err.message) return String(err.message);
    if (typeof err === "string" && err) return err;
    return fallback || "";
  }

  /**
   * v1.23: host-conflict banner line. Uses only device_label + is_online; never an id,
   * never "null"/"undefined". Blank/missing label → "another device"; unknown online → omitted.
   */
  const GENERIC_HOST_LABEL = "another device";
  function hostConflictMeta(host) {
    const tail = "If you reinstalled this app, admin must Change print host to this PC, then tap Retry.";
    if (!host || typeof host !== "object") return tail;
    const raw = typeof host.device_label === "string" ? host.device_label.trim() : "";
    const label = raw && !/^(null|undefined)$/i.test(raw) ? raw : GENERIC_HOST_LABEL;
    const online =
      host.is_online === true ? " (online)" : host.is_online === false ? " (offline)" : "";
    return "Current host: " + label + online + ". " + tail;
  }

  return {
    isFreshPairingPrompt,
    shouldClearField,
    createFieldClearTracker,
    errorText,
    hostConflictMeta,
    GENERIC_HOST_LABEL,
  };
});
