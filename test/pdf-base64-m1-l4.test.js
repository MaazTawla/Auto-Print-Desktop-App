"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  BASE64_MAX_PDF_BYTES,
  normalizePdfBase64Input,
  estimateDecodedBase64Bytes,
  assertBase64WithinDecodedMax,
} = require("../src/pdf-fetch-policy");

describe("pdf_base64 M1 pre-decode cap + L4 data-URI", () => {
  it("normalize strips data:application/pdf;base64, and whitespace", () => {
    const raw = "JVBERi0xLjQ=";
    const withUri = `data:application/pdf;base64,${raw.slice(0, 4)}\n${raw.slice(4)}`;
    assert.equal(normalizePdfBase64Input(withUri), raw);
    assert.equal(normalizePdfBase64Input(`  ${raw}  `), raw);
  });

  it("normalize rejects non-pdf data: URI as INVALID_PDF (L4)", () => {
    assert.throws(
      () => normalizePdfBase64Input("data:application/octet-stream;base64,JVBERi0="),
      (err) => err && err.code === "INVALID_PDF"
    );
    assert.throws(
      () => normalizePdfBase64Input("data:text/plain;base64,JVBERi0="),
      (err) => err && err.code === "INVALID_PDF"
    );
  });

  it("estimateDecodedBase64Bytes uses len*3/4 minus padding", () => {
    assert.equal(estimateDecodedBase64Bytes("AAAA"), 3); // 4 chars → 3 bytes
    assert.equal(estimateDecodedBase64Bytes("AAA="), 2);
    assert.equal(estimateDecodedBase64Bytes("AA=="), 1);
  });

  it("assertBase64WithinDecodedMax rejects before decode (M1)", () => {
    const max = 16;
    // 24 base64 chars → ~18 decoded bytes > 16
    const huge = "A".repeat(24);
    assert.ok(estimateDecodedBase64Bytes(huge) > max);
    assert.throws(
      () => assertBase64WithinDecodedMax(huge, max),
      (err) => err && err.code === "PDF_TOO_LARGE" && err.sizeBytes > max
    );
    // Under cap is fine
    assert.equal(assertBase64WithinDecodedMax("AAAA", max), 3);
  });

  it("5MB default cap is unchanged", () => {
    assert.equal(BASE64_MAX_PDF_BYTES, 5 * 1024 * 1024);
  });
});
