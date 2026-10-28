/**
 * Windows printer → agent external_id.
 * Backend confirmed: win:{Windows printer name}
 * Isolated here so claim/merge rules can change in one place.
 */

"use strict";

/**
 * @param {string} windowsPrinterName - Exact Windows printer name
 * @returns {string} external_id e.g. win:Kitchen Printer 1
 */
function windowsPrinterExternalId(windowsPrinterName) {
  const name = String(windowsPrinterName || "").trim();
  if (!name) return "";
  if (/^win:/i.test(name)) return `win:${name.slice(4)}`;
  return `win:${name}`;
}

/**
 * Optional LAN fields for printers/sync when the Windows port looks like a network printer.
 * @returns {{ ip_address?: string, port?: number } | null}
 */
function inferNetworkEndpointFromWindowsPrinter(p) {
  if (!p || typeof p !== "object") return null;
  const portName = String(p.portName || p.port || "").trim();
  const ipMatch = portName.match(/(\d{1,3}(?:\.\d{1,3}){3})/);
  if (!ipMatch) return null;
  const ip = ipMatch[1];
  const afterIp = portName.slice(ipMatch.index + ip.length);
  let port = null;
  // Port only from suffix after the IP (e.g. 192.168.1.9_9100 or 192.168.1.9:9100)
  const portMatch = afterIp.match(/^[:_](\d{2,5})\b/) || afterIp.match(/[,:](\d{2,5})\b/);
  if (portMatch) {
    const n = Number(portMatch[1]);
    if (Number.isFinite(n) && n > 0 && n < 65536) port = n;
  }
  // Standard TCP/IP ports often look like IP_192.168.1.21 (no explicit port)
  if (port == null && /ip_/i.test(portName)) port = 9100;
  const out = { ip_address: ip };
  if (port != null) out.port = port;
  return out;
}

module.exports = {
  windowsPrinterExternalId,
  inferNetworkEndpointFromWindowsPrinter,
};
