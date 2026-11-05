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
const {
  capExternalId,
  capSyncPrinterRow,
  resolvePrinterName,
  sanitizePort,
  normalizeStatusFields,
  codePointLength,
} = require("./printer-field-limits");

/**
 * Registry boundary: every external_id is trimmed then passed through the
 * single capExternalId (R20D-M1/M2). Idempotent for already-capped ids.
 */
function normalizeExternalId(raw) {
  return capExternalId(String(raw || "").trim());
}

function normalizeAliasKey(raw) {
  return normalizeExternalId(raw).toLowerCase();
}

/** Record from→to and rewrite any aliases that pointed at from. */
function migrateEidAlias(existing, from, to) {
  const src = normalizeExternalId(from);
  const dst = normalizeExternalId(to);
  if (!src || !dst || src.toLowerCase() === dst.toLowerCase()) {
    return { ...(existing || {}) };
  }
  const out = {};
  const map = existing && typeof existing === "object" ? existing : {};
  for (const [k, v] of Object.entries(map)) {
    const key = normalizeAliasKey(k);
    let value = normalizeExternalId(v);
    if (!key || !value) continue;
    if (value.toLowerCase() === src.toLowerCase()) value = dst;
    if (key === value.toLowerCase()) continue;
    out[key] = value;
  }
  out[normalizeAliasKey(src)] = dst;
  return out;
}

function resolveEidAlias(externalId, aliases) {
  let cur = normalizeExternalId(externalId);
  if (!cur) return cur;
  const map = aliases && typeof aliases === "object" ? aliases : {};
  const seen = new Set();
  while (true) {
    const key = cur.toLowerCase();
    if (seen.has(key)) return cur;
    seen.add(key);
    const nextRaw = map[key];
    const next = nextRaw != null ? normalizeExternalId(nextRaw) : "";
    if (!next || next.toLowerCase() === cur.toLowerCase()) return cur;
    cur = next;
  }
}

/**
 * One-time migration of persisted eidAliases: cap keys and values, and keep a
 * lowercase(raw) → capped mapping so legacy lookups still resolve (R20D-M2).
 */
function migrateStoredAliases(existing) {
  const out = {};
  const map = existing && typeof existing === "object" ? existing : {};
  for (const [k, v] of Object.entries(map)) {
    const rawKey = String(k || "").trim();
    const rawVal = String(v || "").trim();
    if (!rawKey || !rawVal) continue;
    const cappedKey = normalizeExternalId(rawKey);
    const cappedVal = normalizeExternalId(rawVal);
    if (!cappedKey || !cappedVal) continue;
    if (cappedKey.toLowerCase() !== cappedVal.toLowerCase()) {
      out[cappedKey.toLowerCase()] = cappedVal;
    }
    // Lookups always normalize/cap first, so a raw key over 255 is never
    // consulted — drop it so migration is idempotent (R21D-I2).
    const rawKeyLower = rawKey.toLowerCase();
    if (
      rawKeyLower !== cappedKey.toLowerCase() &&
      codePointLength(rawKey) <= 255
    ) {
      out[rawKeyLower] = cappedVal;
    }
  }
  return out;
}

function createPrinterRegistry(initial = {}) {
  /** @type {Map<string, object>} */
  const byExternalId = new Map();
  /** @type {Record<string, string>} old eid → new eid */
  let eidAliases =
    initial.eidAliases && typeof initial.eidAliases === "object"
      ? migrateStoredAliases(initial.eidAliases)
      : {};
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
    const rawName =
      printer.name != null
        ? String(printer.name)
        : windowsName || (prev && prev.name) || "";
    const cleanedName = resolvePrinterName(rawName, externalId);
    const statusRaw =
      printer.status != null
        ? printer.status
        : (prev && prev.status) || "online";
    const detailIn =
      printer.status_detail != null
        ? String(printer.status_detail)
        : prev && prev.status_detail != null
          ? prev.status_detail
          : null;
    const statusFields = normalizeStatusFields(statusRaw, detailIn);
    // R22D-L3 / L14-I4: invalid or omitted ('' / whitespace) port keeps stored.
    let port = prev && prev.port != null ? prev.port : null;
    if (Object.prototype.hasOwnProperty.call(printer, "port")) {
      const sanitized = sanitizePort(printer.port);
      if (sanitized !== undefined) port = sanitized;
    }
    const row = {
      external_id: externalId,
      name: cleanedName,
      windows_name: windowsName || (prev && prev.windows_name) || externalId,
      connection,
      connection_type: connection,
      status: statusFields.status || "online",
      status_detail: statusFields.status_detail,
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
      port: port != null ? port : null,
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
      // Backend confirmed: win:{Windows printer name}. Cap at the registry
      // boundary so seen/prev match the hashed key upsert stores (R20D-M1).
      const externalId = normalizeExternalId(windowsPrinterExternalId(name));
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
      const winId = normalizeExternalId(
        windowsPrinterExternalId(
          String(externalId || "").trim().replace(/^win:/i, "") || id
        )
      );
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

  /**
   * Remove a managed printer by external_id. Promotes another default when needed.
   * Returns the removed row, or null if missing.
   */
  function remove(externalId) {
    const id = normalizeExternalId(externalId);
    if (!id || !byExternalId.has(id)) return null;
    const removed = byExternalId.get(id);
    byExternalId.delete(id);
    if (defaultExternalId === id) {
      defaultExternalId = "";
      if (byExternalId.size) {
        const first = byExternalId.keys().next().value;
        defaultExternalId = first;
        const row = byExternalId.get(first);
        if (row) row.is_default = true;
      }
    }
    return removed;
  }

  function routeMessage(msg) {
    // Keep the trimmed ORIGINAL id for name_fallback (R21D-L1). Hashing it
    // first broke bare Windows names over 251 chars that used to match.
    const rawPrinterId =
      msg && msg.printer_external_id != null
        ? String(msg.printer_external_id).trim()
        : "";
    const externalId = rawPrinterId ? normalizeExternalId(rawPrinterId) : "";
    if (externalId) {
      const resolved = resolveEidAlias(externalId, eidAliases);
      let found = byExternalId.get(resolved) || byExternalId.get(externalId);
      if (!found && !/^win:/i.test(resolved)) {
        found = byExternalId.get(
          normalizeExternalId(windowsPrinterExternalId(resolved))
        );
      }
      if (!found && !/^win:/i.test(externalId)) {
        found = byExternalId.get(
          normalizeExternalId(windowsPrinterExternalId(externalId))
        );
      }
      if (!found && rawPrinterId && !/^win:/i.test(rawPrinterId)) {
        found = byExternalId.get(
          normalizeExternalId(windowsPrinterExternalId(rawPrinterId))
        );
      }
      if (found) return { ok: true, printer: found, matchedBy: "external_id" };
      const bare = rawPrinterId.replace(/^win:/i, "");
      for (const row of byExternalId.values()) {
        if (
          row.windows_name === rawPrinterId ||
          row.name === rawPrinterId ||
          (bare &&
            (row.windows_name === bare || row.name === bare))
        ) {
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
    // L13-L1 / BE v1.32: truncate OS/hardware fields at grapheme boundaries
    // before send; cap status at 16; keep external_id ≤ 255 (hash suffix).
    return list().map((p) =>
      capSyncPrinterRow({
        external_id: p.external_id,
        name: p.name,
        connection: p.connection,
        connection_type: p.connection_type || p.connection,
        status: p.status,
        status_detail: p.status_detail,
        is_default: p.is_default,
        model: p.model,
        ip_address: p.ip_address,
        ...(sanitizePort(p.port) != null ? { port: sanitizePort(p.port) } : {}),
      })
    );
  }

  function serialize() {
    return {
      defaultExternalId,
      printers: list(),
      eidAliases: { ...eidAliases },
    };
  }

  function hydrate(data) {
    byExternalId.clear();
    defaultExternalId = "";
    eidAliases = {};
    if (!data || typeof data !== "object") return;
    const printers = Array.isArray(data.printers) ? data.printers : [];
    for (const p of printers) upsert(p);
    // One-time migration: default + aliases through capExternalId (R20D-M2).
    if (data.eidAliases && typeof data.eidAliases === "object") {
      eidAliases = migrateStoredAliases(data.eidAliases);
    }
    if (data.defaultExternalId) {
      const ok = setDefault(data.defaultExternalId);
      if (!ok) {
        // Raw over-255 default: rows were re-keyed by upsert; try capped form.
        setDefault(normalizeExternalId(data.defaultExternalId));
      }
    }
    // Ensure is_default flags match defaultExternalId after migration.
    if (defaultExternalId && byExternalId.has(defaultExternalId)) {
      for (const row of byExternalId.values()) {
        row.is_default = row.external_id === defaultExternalId;
      }
    }
  }

  function getEidAliases() {
    return { ...eidAliases };
  }

  function setEidAliases(next) {
    eidAliases =
      next && typeof next === "object" ? migrateStoredAliases(next) : {};
    return getEidAliases();
  }

  /**
   * Replace old eid with new printer row. Rejects when new eid already belongs
   * to a different printer. Migrates aliases and carries server_id.
   */
  function replaceExternalId(oldExternalId, printer) {
    const prev = normalizeExternalId(oldExternalId);
    const rowIn = printer && typeof printer === "object" ? printer : {};
    const nextId = normalizeExternalId(
      rowIn.external_id || rowIn.externalId || ""
    );
    if (!nextId) return { ok: false, error: "Missing printer external_id." };
    if (prev && prev.toLowerCase() !== nextId.toLowerCase()) {
      const collision = byExternalId.get(nextId);
      if (collision) {
        const host =
          collision.ip_address && collision.port != null
            ? `${collision.ip_address}:${collision.port}`
            : nextId;
        return {
          ok: false,
          error: `Printer already exists at ${host}`,
          code: "EID_COLLISION",
          existing: collision,
        };
      }
      const oldRow = byExternalId.get(prev);
      if (oldRow && (rowIn.server_id == null && rowIn.id == null)) {
        rowIn.server_id = oldRow.server_id;
      }
      remove(prev);
      eidAliases = migrateEidAlias(eidAliases, prev, nextId);
    }
    const saved = upsert({ ...rowIn, external_id: nextId });
    return { ok: true, printer: saved, aliases: getEidAliases() };
  }

  return {
    list,
    get,
    getByServerId,
    upsert,
    remove,
    replaceExternalId,
    applyServerSync,
    syncFromWindowsList,
    setDefault,
    getDefault,
    routeMessage,
    toSyncPayload,
    serialize,
    hydrate,
    getEidAliases,
    setEidAliases,
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

module.exports = {
  createPrinterRegistry,
  normalizeExternalId,
  migrateEidAlias,
  resolveEidAlias,
  migrateStoredAliases,
};
