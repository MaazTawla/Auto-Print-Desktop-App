/**
 * PDF download policy: Bearer allowlist + size cap + no-auth redirects.
 * Bearer only when pdf_url scheme+host equals register.pdf_host (exact),
 * or API base scheme+host when pdf_host is missing.
 */

"use strict";

const DEFAULT_MAX_PDF_BYTES = 20 * 1024 * 1024; // 20 MB

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
 * Axios config for PDF download.
 * When sending auth: maxRedirects 0 (never follow with Authorization).
 * Always cap maxContentLength / maxBodyLength.
 */
function buildPdfAxiosConfig({ pdfUrl, authToken, pdfHost, apiBase, allowedPdfHosts, maxBytes }) {
  const cap =
    maxBytes != null && Number.isFinite(Number(maxBytes)) && Number(maxBytes) > 0
      ? Number(maxBytes)
      : DEFAULT_MAX_PDF_BYTES;
  const decision = shouldSendBearerForPdfUrl(pdfUrl, {
    pdfHost,
    apiBase,
    allowedPdfHosts,
  });
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

module.exports = {
  DEFAULT_MAX_PDF_BYTES,
  parseOrigin,
  resolvePdfHostAllowOrigin,
  shouldSendBearerForPdfUrl,
  buildPdfAxiosConfig,
  isPdfTooLargeError,
};
