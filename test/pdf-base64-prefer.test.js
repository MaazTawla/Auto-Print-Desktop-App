"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { ERROR_CODES, ASSUMPTIONS, parsePrintMessage } = require("../src/agent-contract");
const { BASE64_MAX_PDF_BYTES } = require("../src/pdf-fetch-policy");

describe("pdf_base64 prefer + caps", () => {
  it("ASSUMPTIONS prefer base64 then url", () => {
    assert.equal(ASSUMPTIONS.pdfDelivery, "base64_then_url");
    assert.equal(ERROR_CODES.MISSING_PDF, "MISSING_PDF");
    assert.equal(BASE64_MAX_PDF_BYTES, 5 * 1024 * 1024);
  });

  it("parsePrintMessage keeps both fields", () => {
    const msg = parsePrintMessage({
      pdf_url: "https://x/a.pdf",
      pdf_base64: "JVBERi0=",
      pdf_sha256: "abc",
    });
    assert.equal(msg.ok, true);
    assert.equal(msg.pdf_url, "https://x/a.pdf");
    assert.equal(msg.pdf_base64, "JVBERi0=");
    assert.equal(msg.pdf_sha256, "abc");
  });
});
