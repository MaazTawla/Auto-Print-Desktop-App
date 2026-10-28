/**
 * Multi-printer registry keyed by external_id.
 * Server assigns numeric printers.id on sync; agents keep routing by external_id.
 * No printer-count cap.
 */

"use strict";

const {
  windowsPrinterExternalId,
  inferNetworkEndpointFromWindowsPrinter,
} = require("./windows-external-id");

function normalizeExternalId(raw) {
  return String(raw || "").trim();
}

function createPrinterRegistry(initial = {}) {
  /** @type {Map<string, object>} */
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

  function getByServerId(serverId) {
    const n = Number(serverId);
    if (!Number.isFinite(n)) return null;
    for (const row of byExternalId.values()) {
      if (Number(row.server_id) === n) return row;
    }
    return null;
  }

  function upsert(printer) {
    const windowsName = String(
      printer.windows_name || printer.name || printer.external_id || ""
    ).trim();
    const externalId = normalizeExternalId(
      printer.external_id ||
        printer.externalId ||
        (windowsName ? windowsPrinterExternalId(windowsName) : "")
    );
    if (!externalId) return null;
    const prev = byExternalId.get(externalId);
    const connection =
      printer.connection_type ||
      printer.connection ||
      (prev && prev.connection) ||
      "lan";
    const row = {
      external_id: externalId,
      name: String(printer.name || windowsName).trim() || externalId,
      windows_name: windowsName || (prev && prev.windows_name) || externalId,
      connection,
      connection_type: connection,
      status: printer.status || (prev && prev.status) || "online",
      status_detail:
        printer.status_detail != null
          ? String(printer.status_detail)
          : (prev && prev.status_detail) || null,
      is_default: Boolean(printer.is_default ?? printer.isDefault),
      model:
        printer.model != null
          ? String(printer.model)
          : prev && prev.model
            ? prev.model
            : undefined,
      ip_address:
        printer.ip_address != null
          ? String(printer.ip_address)
          : (prev && prev.ip_address) || null,
      port:
        printer.port != null && Number.isFinite(Number(printer.port))
          ? Number(printer.port)
          : (prev && prev.port) || null,
      // Server-assigned numeric id from printers/sync
      server_id:
        printer.server_id != null
          ? Number(printer.server_id)
          : printer.id != null
            ? Number(printer.id)
            : prev && prev.server_id != null
              ? Number(prev.server_id)
              : null,
    };
    if (row.server_id != null && !Number.isFinite(row.server_id)) {
      row.server_id = null;
    }
    byExternalId.set(externalId, row);
    if (row.is_default) defaultExternalId = externalId;
    return row;
  }

  /**
   * Apply server sync response printers[] — store assigned ids by external_id.
   */
  function applyServerSync(serverPrinters) {
    const rows = Array.isArray(serverPrinters) ? serverPrinters : [];
    for (const p of rows) {
      const externalId = normalizeExternalId(p.external_id);
      if (!externalId) continue;
      const prev = byExternalId.get(externalId);
      upsert({
        ...(prev || {}),
        external_id: externalId,
        name: p.name || (prev && prev.name) || externalId,
        windows_name: (prev && prev.windows_name) || p.name || externalId,
        connection: p.connection_type || p.connection || (prev && prev.connection),
        status: p.status || (prev && prev.status) || "online",
        status_detail: p.status_detail,
        is_default:
          p.is_default != null
            ? Boolean(p.is_default)
            : Boolean(prev && prev.is_default),
        model: p.model,
        ip_address: p.ip_address,
        server_id: p.id,
        id: p.id,
      });
    }
    return list();
  }

  function syncFromWindowsList(windowsPrinters, opts = {}) {
    const keepMissing = opts.keepMissing === true;
    const seen = new Set();
    const rows = Array.isArray(windowsPrinters) ? windowsPrinters : [];
    for (const p of rows) {
      const name = String(
        (p && (p.name || p.deviceName || p.printerName)) || ""
      ).trim();
      if (!name) continue;
      // Backend confirmed: win:{Windows printer name}
      const externalId = windowsPrinterExternalId(name);
      seen.add(externalId);
      const prev = byExternalId.get(externalId);
      const net = inferNetworkEndpointFromWindowsPrinter(p);
      upsert({
        external_id: externalId,
        name: (prev && prev.name) || name,
        windows_name: name,
        connection: (prev && prev.connection) || inferConnection(p),
        status: mapWindowsStatus(p).status,
        status_detail: mapWindowsStatus(p).status_detail,
        is_default:
          (prev && prev.is_default) ||
          Boolean(p && (p.isDefault || p.is_default)) ||
          externalId === defaultExternalId,
        model: (p && (p.model || p.driverName)) || (prev && prev.model),
        server_id: prev && prev.server_id,
        ip_address:
          (net && net.ip_address) ||
          (prev && prev.ip_address) ||
          inferIp(p),
        port: (net && net.port) || (prev && prev.port) || null,
      });
    }
    if (!keepMissing) {
      // Only drop Windows-spooler rows that disappeared. Keep lan:/bt:/usb: scan adds.
      for (const id of [...byExternalId.keys()]) {
        if (!seen.has(id) && /^win:/i.test(id)) byExternalId.delete(id);
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
    let id = normalizeExternalId(externalId);
    if (!id) return false;
    if (!byExternalId.has(id)) {
      const winId = windowsPrinterExternalId(id.replace(/^win:/i, "") || id);
      if (byExternalId.has(winId)) id = winId;
      else {
        for (const row of byExternalId.values()) {
          if (row.windows_name === id || row.name === id) {
            id = row.external_id;
            break;
          }
        }
      }
    }
    if (!byExternalId.has(id)) return false;
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

  function routeMessage(msg) {
    const externalId =
      msg && msg.printer_external_id
        ? normalizeExternalId(msg.printer_external_id)
        : "";
    if (externalId) {
      let found = byExternalId.get(externalId);
      if (!found && !/^win:/i.test(externalId)) {
        found = byExternalId.get(windowsPrinterExternalId(externalId));
      }
      if (found) return { ok: true, printer: found, matchedBy: "external_id" };
      for (const row of byExternalId.values()) {
        if (row.windows_name === externalId || row.name === externalId) {
          return { ok: true, printer: row, matchedBy: "name_fallback" };
        }
      }
      return {
        ok: false,
        reason: "unknown_printer_external_id",
        external_id: externalId,
      };
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
      connection_type: p.connection_type || p.connection,
      status: p.status === "out_of_paper" ? "error" : p.status,
      status_detail:
        p.status === "out_of_paper"
          ? p.status_detail || "Out of paper"
          : p.status_detail,
      is_default: p.is_default,
      model: p.model,
      ip_address: p.ip_address,
      ...(p.port != null ? { port: p.port } : {}),
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
    getByServerId,
    upsert,
    applyServerSync,
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

function inferIp(p) {
  const port = String((p && (p.portName || p.port)) || "");
  const m = port.match(/(\d+\.\d+\.\d+\.\d+)/);
  return m ? m[1] : null;
}

function mapWindowsStatus(p) {
  if (!p) return { status: "offline", status_detail: null };
  const st = String(p.status || p.printerStatus || "").toLowerCase();
  if (!st || st === "idle" || st === "ready" || st === "0") {
    return { status: "online", status_detail: null };
  }
  if (st.includes("paper") || st.includes("out")) {
    return { status: "error", status_detail: "Out of paper" };
  }
  if (st.includes("offline")) {
    return { status: "offline", status_detail: st };
  }
  if (st.includes("error") || st.includes("door")) {
    return { status: "error", status_detail: st };
  }
  return { status: "online", status_detail: null };
}

module.exports = { createPrinterRegistry, normalizeExternalId };
