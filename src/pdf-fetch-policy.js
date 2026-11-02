/**
 * PDF download policy: Bearer allowlist + size cap + no-auth redirects.
 * Bearer only when pdf_url scheme+host equals register.pdf_host (exact),
 * or API base scheme+host when pdf_host is missing.
 * Disallowed hosts: do not GET — fail with PDF_HOST_NOT_ALLOWED.
 */

"use strict";

const DEFAULT_MAX_PDF_BYTES = 20 * 1024 * 1024; // 20 MB
const BASE64_MAX_PDF_BYTES = 5 * 1024 * 1024; // 5 MB decoded pdf_base64

function parseOrigin(urlOrBase) {
  if (urlOrBase == null || String(urlOrBase).trim() === "") return null;
  try {
    let raw = String(urlOrBase).trim();
    // pdf_host is scheme+host (no path); URL() needs a path sometimes
    if (/^https?:\/\/[^/]+$/i.test(raw)) raw = raw + "/";
    if (!/^https?:\/\//i.test(raw)) return null;
    const u = new URL(raw);
    return {
      scheme: u.protocol.replace(/:$/, "").toLowerCase(),
      host: u.host.toLowerCase(), // includes port if non-default
      origin: `${u.protocol}//${u.host}`.toLowerCase(),
    };
  } catch {
    return null;
  }
}

/**
 * Normalize pdf_host from register (scheme+host) or derive from API base.
 */
function resolvePdfHostAllowOrigin({ pdfHost, apiBase, allowedPdfHosts }) {
  const list = [];
  if (pdfHost) {
    const o = parseOrigin(pdfHost);
    if (o) list.push(o.origin);
  }
  if (Array.isArray(allowedPdfHosts)) {
    for (const h of allowedPdfHosts) {
      const o = parseOrigin(h);
      if (o) list.push(o.origin);
    }
  }
  if (!list.length && apiBase) {
    const o = parseOrigin(apiBase);
    if (o) list.push(o.origin);
  }
  return [...new Set(list)];
}

/**
 * Decide whether to attach Bearer for this pdf_url.
 * Exact scheme+host match against pdf_host (or API base fallback / allowlist).
 */
function shouldSendBearerForPdfUrl(pdfUrl, opts = {}) {
  const urlOrigin = parseOrigin(pdfUrl);
  if (!urlOrigin) return { sendAuth: false, reason: "invalid_url" };
  const allowed = resolvePdfHostAllowOrigin(opts);
  if (!allowed.length) return { sendAuth: false, reason: "no_allowlist" };
  if (allowed.includes(urlOrigin.origin)) {
    return { sendAuth: true, reason: "host_allowed", origin: urlOrigin.origin };
  }
  return {
    sendAuth: false,
    reason: "host_not_allowed",
    origin: urlOrigin.origin,
    allowed,
  };
}

/**
 * Fail closed when pdf_url origin is not on the allowlist.
 * Caller must not perform the GET when this throws.
 */
function assertPdfUrlAllowed(pdfUrl, opts = {}) {
  const decision = shouldSendBearerForPdfUrl(pdfUrl, opts);
  if (decision.reason === "host_allowed") return decision;
  const err = new Error("PDF_HOST_NOT_ALLOWED");
  err.code = "PDF_HOST_NOT_ALLOWED";
  err.reason = decision.reason;
  err.origin = decision.origin || null;
  err.allowed = decision.allowed || [];
  err.retryable = false;
  throw err;
}

/**
 * Axios config for PDF download.
 * Asserts allowlist unless skipAllowCheck (tests only).
 * When sending auth: maxRedirects 0. Always cap body size.
 */
function buildPdfAxiosConfig({ pdfUrl, authToken, pdfHost, apiBase, allowedPdfHosts, maxBytes, skipAllowCheck }) {
  const cap =
    maxBytes != null && Number.isFinite(Number(maxBytes)) && Number(maxBytes) > 0
      ? Number(maxBytes)
      : DEFAULT_MAX_PDF_BYTES;
  const decision = skipAllowCheck
    ? shouldSendBearerForPdfUrl(pdfUrl, { pdfHost, apiBase, allowedPdfHosts })
    : assertPdfUrlAllowed(pdfUrl, { pdfHost, apiBase, allowedPdfHosts });
  const headers = {};
  if (decision.sendAuth && authToken) {
    headers.Authorization = `Bearer ${authToken}`;
  }
  return {
    url: pdfUrl,
    headers,
    sendAuth: Boolean(decision.sendAuth && authToken),
    decision,
    maxBytes: cap,
    axiosConfig: {
      responseType: "arraybuffer",
      timeout: 120000,
      headers,
      maxRedirects: decision.sendAuth && authToken ? 0 : 5,
      maxContentLength: cap,
      maxBodyLength: cap,
      validateStatus: () => true,
    },
  };
}

function isPdfTooLargeError(err) {
  if (!err) return false;
  const msg = String(err.message || err);
  return (
    err.code === "ERR_FR_MAX_CONTENT_LENGTH" ||
    err.code === "ERR_FR_MAX_BODY_LENGTH" ||
    /maxcontentlength|max body length|content length/i.test(msg)
  );
}

/** Optional data:application/pdf;base64, only — any other data: URI is INVALID_PDF. */
const PDF_DATA_URI_RE = /^data:application\/pdf;base64,/i;
const ANY_DATA_URI_RE = /^data:/i;

/**
 * Strip whitespace and an optional data:application/pdf;base64, prefix.
 * Rejects other data: URIs before any decode allocation.
 * @returns {string} raw base64 alphabet payload
 */
function normalizePdfBase64Input(raw) {
  let s = String(raw ?? "").trim();
  if (!s) {
    const err = new Error("Empty pdf_base64");
    err.code = "EMPTY_PDF_BASE64";
    throw err;
  }
  if (ANY_DATA_URI_RE.test(s)) {
    const m = PDF_DATA_URI_RE.exec(s);
    if (!m) {
      const err = new Error("INVALID_PDF");
      err.code = "INVALID_PDF";
      err.retryable = false;
      throw err;
    }
    s = s.slice(m[0].length);
  }
  s = s.replace(/\s+/g, "");
  if (!s) {
    const err = new Error("Empty pdf_base64");
    err.code = "EMPTY_PDF_BASE64";
    throw err;
  }
  return s;
}

/**
 * Estimate decoded byte length from a base64 payload (no decode).
 * Uses len*3/4 minus padding.
 */
function estimateDecodedBase64Bytes(b64) {
  const s = String(b64 || "");
  const len = s.length;
  let padding = 0;
  if (len >= 2 && s.endsWith("==")) padding = 2;
  else if (len >= 1 && s.endsWith("=")) padding = 1;
  return Math.floor((len * 3) / 4) - padding;
}

/**
 * Reject oversized pdf_base64 before Buffer.from allocates the decoded body.
 */
function assertBase64WithinDecodedMax(b64, maxBytes = BASE64_MAX_PDF_BYTES) {
  const cap =
    maxBytes != null && Number.isFinite(Number(maxBytes)) && Number(maxBytes) > 0
      ? Number(maxBytes)
      : BASE64_MAX_PDF_BYTES;
  const estimated = estimateDecodedBase64Bytes(b64);
  if (estimated > cap) {
    const err = new Error("PDF_TOO_LARGE");
    err.code = "PDF_TOO_LARGE";
    err.retryable = false;
    err.sizeBytes = estimated;
    err.maxBytes = cap;
    throw err;
  }
  return estimated;
}

module.exports = {
  DEFAULT_MAX_PDF_BYTES,
  BASE64_MAX_PDF_BYTES,
  parseOrigin,
  resolvePdfHostAllowOrigin,
  shouldSendBearerForPdfUrl,
  assertPdfUrlAllowed,
  buildPdfAxiosConfig,
  isPdfTooLargeError,
  normalizePdfBase64Input,
  estimateDecodedBase64Bytes,
  assertBase64WithinDecodedMax,
  PDF_DATA_URI_RE,
};
