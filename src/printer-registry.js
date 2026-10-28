/**
 * Multi-printer registry keyed by external_id (Windows printer name by default).
 * No printer-count cap. Routes v2 messages by printer_external_id.
 */

"use strict";

function normalizeExternalId(raw) {
  return String(raw || "").trim();
}

function createPrinterRegistry(initial = {}) {
  /** @type {Map<string, { external_id: string, name: string, windows_name: string, connection: string, status: string, is_default: boolean, model?: string }>} */
  const byExternalId = new Map();
  let defaultExternalId =
    initial.defaultExternalId != null
      ? normalizeExternalId(initial.defaultExternalId)
      : "";

  function list() {
    return [...byExternalId.values()];
  }

  function get(externalId) {
    const id = normalizeExternalId(externalId);
    return id ? byExternalId.get(id) || null : null;
  }

  function upsert(printer) {
    const windowsName = String(
      printer.windows_name || printer.name || printer.external_id || ""
    ).trim();
    const externalId = normalizeExternalId(
      printer.external_id || printer.externalId || windowsName
    );
    if (!externalId) return null;
    const row = {
      external_id: externalId,
      name: String(printer.name || windowsName).trim() || externalId,
      windows_name: windowsName || externalId,
      connection: printer.connection || "lan",
      status: printer.status || "online",
      is_default: Boolean(printer.is_default ?? printer.isDefault),
      model: printer.model != null ? String(printer.model) : undefined,
    };
    byExternalId.set(externalId, row);
    if (row.is_default) defaultExternalId = externalId;
    return row;
  }

  /**
   * Replace registry from Windows spooler list (pdf-to-printer getPrinters).
   * Preserves is_default / mapping metadata when external_id matches.
   */
  function syncFromWindowsList(windowsPrinters, opts = {}) {
    const keepMissing = opts.keepMissing === true;
    const seen = new Set();
    const rows = Array.isArray(windowsPrinters) ? windowsPrinters : [];
    for (const p of rows) {
      const name = String(
        (p && (p.name || p.deviceName || p.printerName)) || ""
      ).trim();
      if (!name) continue;
      const externalId = normalizeExternalId(
        (p && (p.external_id || p.deviceId)) || name
      );
      seen.add(externalId);
      const prev = byExternalId.get(externalId);
      upsert({
        external_id: externalId,
        name: (prev && prev.name) || name,
        windows_name: name,
        connection: (prev && prev.connection) || inferConnection(p),
        status: mapWindowsStatus(p),
        is_default:
          (prev && prev.is_default) ||
          Boolean(p && (p.isDefault || p.is_default)) ||
          externalId === defaultExternalId,
        model: (p && (p.model || p.driverName)) || (prev && prev.model),
      });
    }
    if (!keepMissing) {
      for (const id of [...byExternalId.keys()]) {
        if (!seen.has(id)) byExternalId.delete(id);
      }
    }
    if (defaultExternalId && !byExternalId.has(defaultExternalId)) {
      defaultExternalId = "";
    }
    if (!defaultExternalId && byExternalId.size) {
      const first = byExternalId.keys().next().value;
      defaultExternalId = first;
      const row = byExternalId.get(first);
      if (row) row.is_default = true;
    }
    return list();
  }

  function setDefault(externalId) {
    const id = normalizeExternalId(externalId);
    if (!id || !byExternalId.has(id)) return false;
    defaultExternalId = id;
    for (const row of byExternalId.values()) {
      row.is_default = row.external_id === id;
    }
    return true;
  }

  function getDefault() {
    if (defaultExternalId && byExternalId.has(defaultExternalId)) {
      return byExternalId.get(defaultExternalId);
    }
    return null;
  }

  /**
   * Resolve which Windows printer name to use for a v2 (or legacy) message.
   * @returns {{ ok: true, printer: object } | { ok: false, reason: string }}
   */
  function routeMessage(msg) {
    const externalId =
      msg && msg.printer_external_id
        ? normalizeExternalId(msg.printer_external_id)
        : "";
    if (externalId) {
      const found = byExternalId.get(externalId);
      if (found) return { ok: true, printer: found, matchedBy: "external_id" };
      // Fallback: treat external_id as Windows printer name
      for (const row of byExternalId.values()) {
        if (row.windows_name === externalId || row.name === externalId) {
          return { ok: true, printer: row, matchedBy: "name_fallback" };
        }
      }
      return { ok: false, reason: "unknown_printer_external_id", external_id: externalId };
    }
    const def = getDefault();
    if (def) return { ok: true, printer: def, matchedBy: "default" };
    return { ok: false, reason: "no_default_printer" };
  }

  function toSyncPayload() {
    return list().map((p) => ({
      external_id: p.external_id,
      name: p.name,
      connection: p.connection,
      status: p.status,
      is_default: p.is_default,
      model: p.model,
    }));
  }

  function serialize() {
    return {
      defaultExternalId,
      printers: list(),
    };
  }

  function hydrate(data) {
    byExternalId.clear();
    defaultExternalId = "";
    if (!data || typeof data !== "object") return;
    const printers = Array.isArray(data.printers) ? data.printers : [];
    for (const p of printers) upsert(p);
    if (data.defaultExternalId) setDefault(data.defaultExternalId);
  }

  return {
    list,
    get,
    upsert,
    syncFromWindowsList,
    setDefault,
    getDefault,
    routeMessage,
    toSyncPayload,
    serialize,
    hydrate,
  };
}

function inferConnection(p) {
  const port = String((p && (p.portName || p.port)) || "").toLowerCase();
  if (port.startsWith("usb")) return "usb";
  if (port.includes("bluetooth") || port.startsWith("bth")) return "bt";
  if (/^\d+\.\d+\.\d+\.\d+/.test(port) || port.startsWith("ip_")) return "lan";
  return "lan";
}

function mapWindowsStatus(p) {
  if (!p) return "offline";
  const st = String(p.status || p.printerStatus || "").toLowerCase();
  if (!st || st === "idle" || st === "ready" || st === "0") return "online";
  if (st.includes("paper") || st.includes("out")) return "out_of_paper";
  if (st.includes("error") || st.includes("offline") || st.includes("door")) {
    return st.includes("offline") ? "offline" : "error";
  }
  return "online";
}

module.exports = { createPrinterRegistry, normalizeExternalId };
