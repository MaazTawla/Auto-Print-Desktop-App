/**
 * Map Windows spooler rows + LAN scan hits into Add-printer candidates.
 * external_id shapes: win:{name}, lan:{ip}:{port}, bt:{MAC}, usb:{…}
 */

"use strict";

const { windowsPrinterExternalId } = require("./windows-external-id");
const { capExternalId } = require("./printer-field-limits");

const DEFAULT_LAN_PORT = 9100;

function lanExternalId(ip, port = DEFAULT_LAN_PORT) {
  const host = String(ip || "").trim();
  if (!host) throw new Error("LAN IP required");
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) {
    throw new Error(
      "LAN port must be 1..65535 (got " + port + "); refusing silent remap to " + DEFAULT_LAN_PORT
    );
  }
  return capExternalId(`lan:${host}:${p}`);
}

function btExternalId(mac) {
  const key = String(mac || "").trim().toUpperCase();
  if (!key) throw new Error("Bluetooth MAC required");
  return `bt:${key}`;
}

function fromWindowsPrinter(p) {
  const name = String(
    (p && (p.name || p.deviceName || p.printerName)) || ""
  ).trim();
  if (!name) return null;
  const externalId = capExternalId(windowsPrinterExternalId(name));
  const portName = String((p && (p.portName || p.port || p.deviceId)) || "").trim();
  const connection = inferWindowsConnection(p);
  const typeLabel =
    connection === "usb" ? "USB" : connection === "bt" ? "Bluetooth" : "Windows";
  const addressLabel = portName || name;
  return {
    name,
    connection,
    typeLabel,
    addressLabel,
    externalId,
    windows_name: name,
    host: "",
    port: null,
    bluetoothAddress: "",
    usbIdentity: "",
  };
}

function fromLan({ host, port }) {
  const ip = String(host || "").trim();
  const p = port == null || port === "" ? DEFAULT_LAN_PORT : Number(port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) {
    throw new Error("LAN port must be 1..65535");
  }
  const use = p;
  const externalId = lanExternalId(ip, use);
  return {
    name: `Network ${ip}`,
    connection: "lan",
    typeLabel: "LAN",
    addressLabel: `${ip}:${use}`,
    externalId,
    windows_name: "",
    host: ip,
    port: use,
    bluetoothAddress: "",
    usbIdentity: "",
  };
}

function inferWindowsConnection(p) {
  const port = String((p && (p.portName || p.port || p.deviceId)) || "").toLowerCase();
  if (port.startsWith("usb")) return "usb";
  if (port.includes("bluetooth") || port.startsWith("bth")) return "bt";
  if (/^\d+\.\d+\.\d+\.\d+/.test(port) || port.startsWith("ip_")) return "lan";
  return "windows";
}

/**
 * Merge Windows + LAN discoveries, dedupe by external_id (case-insensitive).
 * Order: USB → Bluetooth → Windows → LAN, then name.
 */
function merge({ windows = [], lan = [] } = {}) {
  const combined = [];
  for (const w of windows) {
    const c = fromWindowsPrinter(w);
    if (c) combined.push(c);
  }
  for (const hit of lan) {
    try {
      combined.push(fromLan(hit));
    } catch (_) {
      /* skip bad hits */
    }
  }
  return dedupe(combined);
}

function dedupe(candidates) {
  const byId = new Map();
  for (const c of candidates || []) {
    const key = String(c.externalId || "")
      .trim()
      .toLowerCase();
    if (!key) continue;
    if (!byId.has(key)) byId.set(key, c);
  }
  return [...byId.values()].sort(candidateOrder);
}

function candidateOrder(a, b) {
  const rank = (c) => {
    if (c.connection === "usb") return 0;
    if (c.connection === "bt") return 1;
    if (c.connection === "windows") return 2;
    return 3;
  };
  const d = rank(a) - rank(b);
  if (d !== 0) return d;
  const an = String(a.name || "").toLowerCase();
  const bn = String(b.name || "").toLowerCase();
  if (an < bn) return -1;
  if (an > bn) return 1;
  return String(a.addressLabel || "").localeCompare(String(b.addressLabel || ""));
}

function isAlreadyAdded(candidate, managed) {
  const id = String((candidate && candidate.externalId) || "")
    .trim()
    .toLowerCase();
  if (!id) return false;
  const list = Array.isArray(managed) ? managed : [];
  if (list.some((p) => String(p.external_id || "").trim().toLowerCase() === id)) {
    return true;
  }
  if (candidate.connection === "lan") {
    return list.some(
      (p) =>
        String(p.connection || p.connection_type || "").toLowerCase() === "lan" &&
        String(p.ip_address || "") === String(candidate.host || "") &&
        Number(p.port) === Number(candidate.port)
    );
  }
  if (candidate.windows_name) {
    return list.some(
      (p) =>
        String(p.windows_name || "") === candidate.windows_name ||
        String(p.name || "") === candidate.windows_name
    );
  }
  return false;
}

function toRegistryPrinter(candidate, { makeDefault = false } = {}) {
  const connection =
    candidate.connection === "windows" ? "lan" : candidate.connection;
  return {
    external_id: candidate.externalId,
    name: candidate.name,
    windows_name: candidate.windows_name || candidate.name,
    connection,
    connection_type: connection,
    is_default: !!makeDefault,
    ip_address: candidate.host || null,
    port: candidate.port != null ? Number(candidate.port) : null,
  };
}

module.exports = {
  DEFAULT_LAN_PORT,
  lanExternalId,
  btExternalId,
  fromWindowsPrinter,
  fromLan,
  merge,
  dedupe,
  isAlreadyAdded,
  toRegistryPrinter,
};
