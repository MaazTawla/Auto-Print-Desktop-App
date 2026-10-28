"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const axios = require("axios");
const {
  shouldSendBearerForPdfUrl,
  buildPdfAxiosConfig,
  assertPdfUrlAllowed,
  parseOrigin,
  DEFAULT_MAX_PDF_BYTES,
} = require("../src/pdf-fetch-policy");

describe("pdf-fetch-policy", () => {
  it("parses pdf_host scheme+host exactly", () => {
    const o = parseOrigin("https://api.tawla.io");
    assert.equal(o.origin, "https://api.tawla.io");
    assert.equal(o.host, "api.tawla.io");
  });

  it("sends Bearer only when scheme+host equals pdf_host", () => {
    const ok = shouldSendBearerForPdfUrl("https://api.tawla.io/pdfs/1.pdf", {
      pdfHost: "https://api.tawla.io",
    });
    assert.equal(ok.sendAuth, true);

    const bad = shouldSendBearerForPdfUrl("https://evil.example/steal", {
      pdfHost: "https://api.tawla.io",
    });
    assert.equal(bad.sendAuth, false);
    assert.equal(bad.reason, "host_not_allowed");
  });

  it("falls back to API base host when pdf_host missing", () => {
    const ok = shouldSendBearerForPdfUrl("https://api.tawla.io/x.pdf", {
      apiBase: "https://api.tawla.io/api/v1/print-agent",
    });
    assert.equal(ok.sendAuth, true);

    const bad = shouldSendBearerForPdfUrl("http://127.0.0.1:9/x", {
      apiBase: "https://api.tawla.io",
    });
    assert.equal(bad.sendAuth, false);
  });

  it("N1: host_not_allowed throws PDF_HOST_NOT_ALLOWED and must not GET", async () => {
    let hits = 0;
    const server = http.createServer((_req, res) => {
      hits += 1;
      res.writeHead(200);
      res.end("%PDF");
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address();
    const url = `http://127.0.0.1:${port}/evil.pdf`;
    assert.throws(
      () =>
        assertPdfUrlAllowed(url, {
          pdfHost: "https://api.tawla.io",
          apiBase: "https://api.tawla.io",
        }),
      (err) => err && err.code === "PDF_HOST_NOT_ALLOWED"
    );
    assert.throws(
      () =>
        buildPdfAxiosConfig({
          pdfUrl: url,
          authToken: "super-secret-token",
          pdfHost: "https://api.tawla.io",
          apiBase: "https://api.tawla.io",
        }),
      (err) => err && err.code === "PDF_HOST_NOT_ALLOWED"
    );
    // Confirm no accidental GET was issued by the policy helpers
    assert.equal(hits, 0);
    await new Promise((r) => server.close(r));
  });

  it("foreign-host with skipAllowCheck still withholds Bearer (probe)", async () => {
    let sawAuth = null;
    const server = http.createServer((req, res) => {
      sawAuth = req.headers.authorization || null;
      res.writeHead(200, { "Content-Type": "application/pdf" });
      res.end("%PDF-1.4 probe");
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address();
    const url = `http://127.0.0.1:${port}/evil.pdf`;
    const built = buildPdfAxiosConfig({
      pdfUrl: url,
      authToken: "super-secret-token",
      pdfHost: "https://api.tawla.io",
      apiBase: "https://api.tawla.io",
      skipAllowCheck: true,
    });
    assert.equal(built.sendAuth, false);
    assert.equal(built.headers.Authorization, undefined);
    try {
      await axios.get(built.url, built.axiosConfig);
    } finally {
      await new Promise((r) => server.close(r));
    }
    assert.equal(sawAuth, null);
  });

  it("same-host probe: Bearer attached and maxRedirects 0", () => {
    const built = buildPdfAxiosConfig({
      pdfUrl: "https://api.tawla.io/files/a.pdf",
      authToken: "tok",
      pdfHost: "https://api.tawla.io",
    });
    assert.equal(built.sendAuth, true);
    assert.equal(built.headers.Authorization, "Bearer tok");
    assert.equal(built.axiosConfig.maxRedirects, 0);
    assert.equal(built.axiosConfig.maxContentLength, DEFAULT_MAX_PDF_BYTES);
  });

  it("scheme mismatch does not send Bearer", () => {
    const d = shouldSendBearerForPdfUrl("http://api.tawla.io/x.pdf", {
      pdfHost: "https://api.tawla.io",
    });
    assert.equal(d.sendAuth, false);
  });
});
