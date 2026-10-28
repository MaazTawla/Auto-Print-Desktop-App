"use strict";

/**
 * Manual LAN host/port rules aligned with BE v1.6
 * (BranchPrintingController::isIpv6Address → FILTER_VALIDATE_IP + FILTER_FLAG_IPV6).
 */

const net = require("net");

const PORT_RANGE_ERROR = "Port must be an integer between 1 and 65535.";
const IPV6_ERROR =
  "IPv6 addresses are not supported for LAN printers; use IPv4 or a hostname.";
const HOST_REQUIRED_ERROR = "Host / IP is required.";
const NON_HOST_ADD_ERROR =
  "Only the print host can add printers. This device is an observer — ask the print host to add printers.";

function isIpv6Address(host) {
  if (host == null) return false;
  let h = String(host).trim();
  if (!h) return false;
  if (h.startsWith("[") && h.endsWith("]") && h.length > 2) {
    h = h.slice(1, -1);
  }
  return net.isIP(h) === 6;
}

/**
 * Parse manual port. Never defaults to 9100.
 * @returns {number|null}
 */
function parsePortStrict(raw) {
  if (raw == null) return null;
  const t = String(raw).trim();
  if (!t) return null;
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return null;
  return n;
}

/**
 * @returns {string|null} error message or null when OK
 */
function validateManualLan(host, portRaw) {
  const h = host == null ? "" : String(host).trim();
  if (!h) return HOST_REQUIRED_ERROR;
  if (isIpv6Address(h)) return IPV6_ERROR;
  if (parsePortStrict(portRaw) == null) return PORT_RANGE_ERROR;
  return null;
}

function assertPrintHostCanAdd(isPrintHost) {
  if (!isPrintHost) return NON_HOST_ADD_ERROR;
  return null;
}

module.exports = {
  PORT_RANGE_ERROR,
  IPV6_ERROR,
  HOST_REQUIRED_ERROR,
  NON_HOST_ADD_ERROR,
  isIpv6Address,
  parsePortStrict,
  validateManualLan,
  assertPrintHostCanAdd,
};
