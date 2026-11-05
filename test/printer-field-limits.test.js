"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  PRINTER_FIELD_MAX,
  PRINTER_STATUS_MAX,
  MANUAL_HOST_MAX,
  codePointLength,
  truncateAtGraphemeBoundary,
  capExternalId,
  capStatus,
  capSyncPrinterRow,
  validateManualPrinterName,
  validateManualPrinterHost,
  validateManualLanExternalId,
  formatPrinterSyncValidationError,
} = require("../src/printer-field-limits");
const { createPrinterRegistry } = require("../src/printer-registry");
const { lanExternalId } = require("../src/discovered-printer");
const { validateManualLan } = require("../src/lan-host-validation");

describe("L13-L1 printer field limits", () => {
  it("constants match BE v1.32", () => {
    assert.equal(PRINTER_FIELD_MAX, 255);
    assert.equal(PRINTER_STATUS_MAX, 16);
    assert.equal(MANUAL_HOST_MAX, 253);
  });

  it("truncateAtGraphemeBoundary cuts at grapheme under code-point budget", () => {
    const family = "👨‍👩‍👧‍👦"; // multiple code points, one grapheme when Segmenter works
    const raw = "a" + family.repeat(200);
    const out = truncateAtGraphemeBoundary(raw, 255);
    assert.ok(codePointLength(out) <= 255);
    assert.ok(out.length > 0);
    // Mutation: UTF-16 slice would split a surrogate; Array.from path must not.
    const emoji = "😀";
    const long = emoji.repeat(300);
    const capped = truncateAtGraphemeBoundary(long, 255);
    assert.equal(codePointLength(capped), 255);
    assert.equal(capped, emoji.repeat(255));
  });

  it("RA-style: cap at exactly 255 accepts; 256 truncated", () => {
    const ok = "x".repeat(255);
    assert.equal(truncateAtGraphemeBoundary(ok, 255), ok);
    assert.equal(codePointLength(truncateAtGraphemeBoundary(ok + "y", 255)), 255);
  });

  it("capExternalId leaves short ids; hash-suffixes long ones stably", () => {
    assert.equal(capExternalId("lan:1.2.3.4:9100"), "lan:1.2.3.4:9100");
    const long = "lan:" + "h".repeat(300) + ":9100";
    const a = capExternalId(long);
    const b = capExternalId(long);
    assert.equal(a, b, "stable");
    assert.ok(codePointLength(a) <= 255);
    assert.match(a, /#[0-9a-f]{12}$/);
    // Mutation: no hash → still over 255 or unstable truncate-only.
    assert.notEqual(a, long.slice(0, 255));
  });

  it("capStatus maps out_of_paper and hard-caps at 16", () => {
    assert.equal(capStatus("out_of_paper"), "error");
    assert.equal(capStatus("online"), "online");
    assert.equal(codePointLength(capStatus("x".repeat(40))), 16);
  });

  it("capSyncPrinterRow truncates name/model/status_detail/ip and status", () => {
    const row = capSyncPrinterRow({
      external_id: "win:" + "n".repeat(300),
      name: "名".repeat(300),
      model: "m".repeat(300),
      status_detail: "d".repeat(300),
      ip_address: "i".repeat(300),
      status: "s".repeat(40),
    });
    assert.ok(codePointLength(row.external_id) <= 255);
    assert.equal(codePointLength(row.name), 255);
    assert.equal(codePointLength(row.model), 255);
    assert.equal(codePointLength(row.status_detail), 255);
    assert.equal(codePointLength(row.ip_address), 255);
    assert.equal(codePointLength(row.status), 16);
  });

  it("manual validators: name 255 / host 253 / eid", () => {
    assert.equal(validateManualPrinterName("x".repeat(255)), null);
    assert.match(validateManualPrinterName("x".repeat(256)), /255/);
    assert.equal(validateManualPrinterHost("h".repeat(253)), null);
    assert.match(validateManualPrinterHost("h".repeat(254)), /253/);
    assert.equal(validateManualLanExternalId("1.2.3.4", 9100), null);
    assert.match(validateManualLanExternalId("h".repeat(250), 9100), /255/);
  });

  it("validateManualLan rejects over-long host", () => {
    const err = validateManualLan("h".repeat(254), "9100");
    assert.match(err, /253/);
  });

  it("lanExternalId caps when host is extreme", () => {
    const eid = lanExternalId("h".repeat(300), 9100);
    assert.ok(codePointLength(eid) <= 255);
  });

  it("registry toSyncPayload truncates OS-sourced oversize fields", () => {
    const reg = createPrinterRegistry();
    reg.upsert({
      external_id: "win:Kitchen",
      name: "名".repeat(300),
      model: "m".repeat(300),
      status_detail: "detail-" + "z".repeat(300),
      status: "online",
      connection: "usb",
    });
    const [row] = reg.toSyncPayload();
    assert.equal(codePointLength(row.name), 255);
    assert.equal(codePointLength(row.model), 255);
    assert.equal(codePointLength(row.status_detail), 255);
    assert.equal(row.external_id, "win:Kitchen");
  });

  it("formatPrinterSyncValidationError names the printer from details index", () => {
    const payload = [
      { name: "Ok", external_id: "win:Ok" },
      { name: "Bad Kitchen", external_id: "win:Bad" },
    ];
    const msg = formatPrinterSyncValidationError(
      {
        code: "VALIDATION_ERROR",
        message: "The given data was invalid.",
        details: {
          "printers.1.name": ["The printers.1.name may not be greater than 255 characters."],
        },
      },
      payload
    );
    assert.match(msg, /Bad Kitchen/);
    assert.match(msg, /name/i);
    // Mutation: using index alone without name → fails.
    assert.doesNotMatch(msg, /printers\.1/);
  });

  it("formatPrinterSyncValidationError reads nested details.details", () => {
    const msg = formatPrinterSyncValidationError(
      {
        code: "VALIDATION_ERROR",
        message: "invalid",
        details: {
          code: "VALIDATION_ERROR",
          details: { "printers.0.external_id": ["too long"] },
        },
      },
      [{ name: "Solo", external_id: "lan:x:9100" }]
    );
    assert.match(msg, /Solo/);
    assert.match(msg, /external id/i);
  });
});

describe("L13-L1 mutations (wiring)", () => {
  const fs = require("fs");
  const path = require("path");
  const root = path.join(__dirname, "..");
  const rd = (f) => fs.readFileSync(path.join(root, f), "utf8");

  it("manual form has maxlength 255/253 and visible hints", () => {
    const html = rd("index.html");
    assert.match(
      html,
      /id="settings-manual-printer-name"[^>]*maxlength="255"/
    );
    assert.match(
      html,
      /id="settings-manual-printer-host"[^>]*maxlength="253"/
    );
    assert.match(html, /Max 255 characters/);
    assert.match(html, /Max 253 characters/);
  });

  it("toSyncPayload calls capSyncPrinterRow (mutation: remove caps fails)", () => {
    const src = rd("src/printer-registry.js");
    assert.match(src, /capSyncPrinterRow/);
    assert.match(src, /capExternalId/);
  });

  it("sync 422 path formats printer-named message", () => {
    const src = rd("src/station-printing.js");
    assert.match(src, /formatPrinterSyncValidationError/);
    assert.match(src, /VALIDATION_ERROR/);
  });
});

describe("L13-L1 syncPrintersToServer 422 names printer", () => {
  const { createStationPrintingController } = require("../src/station-printing");

  it("returns friendly message with printer name on VALIDATION_ERROR", async () => {
    let cfg = {
      agent_api_base: "https://api.example.com",
      agent_token: "tok",
      pairing_code: "",
      branch_id: "147",
      is_print_host: true,
      host_epoch: 1,
    };
    const ctrl = createStationPrintingController({
      readConfig: () => ({ ...cfg }),
      writeConfig: (p) => {
        cfg = { ...cfg, ...p };
      },
      request: async () => ({
        status: 422,
        data: {
          error: {
            code: "VALIDATION_ERROR",
            message: "The given data was invalid.",
            details: {
              "printers.0.name": ["The printers.0.name may not be greater than 255 characters."],
            },
          },
        },
        headers: {},
      }),
      log: () => {},
      sleep: async () => {},
    });
    ctrl.policy.applyServerState({ is_print_host: true, host_epoch: 1 });
    ctrl.printers.upsert({
      external_id: "win:Long",
      name: "LongNamePrinter",
      connection: "usb",
      status: "online",
    });
    const res = await ctrl.syncPrintersToServer({ force: true });
    assert.equal(res.ok, false);
    assert.match(String(res.error && res.error.message), /LongNamePrinter/);
    assert.match(String(res.message || (res.error && res.error.message)), /LongNamePrinter/);
  });
});
