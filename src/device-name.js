"use strict";
// Default device_label for pairing: OS hostname (Windows computer name), trimmed and
// sanitized, capped at the BE limit (device_label max:120). Fallback: "Desktop Print Agent".
const os = require("os");

const FALLBACK = "Desktop Print Agent";
const MAX_LENGTH = 120;

function sanitizeDeviceName(raw) {
  if (raw == null) return null;
  const s = String(raw)
    .replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}]/gu, (c) => (/\s/.test(c) ? " " : ""))
    .replace(/\s+/gu, " ")
    .trim();
  if (!s) return null;
  const capped = Array.from(s).slice(0, MAX_LENGTH).join("").trim();
  return capped || null;
}

function defaultDeviceName({ hostname, env } = {}) {
  const getHost = hostname || (() => os.hostname());
  const e = env || process.env;
  let h = null;
  try {
    h = sanitizeDeviceName(getHost());
  } catch {
    h = null;
  }
  return h || sanitizeDeviceName(e && e.COMPUTERNAME) || FALLBACK;
}

function labelOrDefault(stored, opts) {
  return sanitizeDeviceName(stored) || defaultDeviceName(opts);
}

module.exports = { sanitizeDeviceName, defaultDeviceName, labelOrDefault, FALLBACK, MAX_LENGTH };
