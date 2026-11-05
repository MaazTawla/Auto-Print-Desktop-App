"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  PRINTER_FIELD_MAX,
  PRINTER_STATUS_MAX,
  MANUAL_HOST_MAX,
  codePointLength,
  truncateAtGraphemeBoundary,
  truncateByCodePoints,
  capExternalId,
  capStatus,
  capSyncPrinterRow,
  validateManualPrinterName,
  rejectMappingIfNameTooLong,
  sanitizePrinterName,
  resolvePrinterName,
  printerNameBlankCheck,
  normalizeStatusFields,
  sanitizePort,
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

  it("capStatus maps out_of_paper and clamps to BE vocab", () => {
    assert.equal(capStatus("out_of_paper"), "error");
    assert.equal(capStatus("online"), "online");
    assert.equal(capStatus("ONLINE"), "online");
    assert.equal(capStatus("paused"), "error");
    assert.equal(capStatus("x".repeat(40)), "error");
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
    assert.equal(row.status, "error");
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

  it("manual form has maxlength 510/506 (UTF-16) and visible code-point hints", () => {
    const html = rd("index.html");
    assert.match(
      html,
      /id="settings-manual-printer-name"[^>]*maxlength="510"/
    );
    assert.match(
      html,
      /id="settings-manual-printer-host"[^>]*maxlength="506"/
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


describe("R20D-G1 code points not graphemes", () => {
  it("family-emoji name over 255 code points is rejected", () => {
    // 40 ZWJ family emoji = 40 graphemes but 280 code points.
    const name = "👨‍👩‍👧‍👦".repeat(40);
    assert.ok(codePointLength(name) > 255);
    assert.match(validateManualPrinterName(name), /255/);
  });
});

describe("R20D-L2 oversized grapheme", () => {
  it("never returns empty for a single grapheme longer than the budget", () => {
    const huge = "e" + "\u0301".repeat(400);
    const out = truncateAtGraphemeBoundary(huge, 16);
    assert.ok(out.length > 0);
    assert.ok(codePointLength(out) <= 16);
    assert.ok(huge.startsWith(out) || out === truncateByCodePoints(huge, 16));
    const status = capStatus("e" + "\u0301".repeat(40));
    assert.ok(String(status).length > 0);
    assert.ok(codePointLength(status) <= 16);
  });
});

describe("R20D-I1 mutant killers (wiring)", () => {
  const fs = require("fs");
  const path = require("path");
  const root = path.join(__dirname, "..");
  const rd = (f) => fs.readFileSync(path.join(root, f), "utf8");

  it("W7: set-printer-mapping rejects a long name via rejectMappingIfNameTooLong", () => {
    const src = rd("src/main.js");
    const i = src.indexOf('ipcMain.handle("set-printer-mapping"');
    assert.ok(i >= 0);
    const slice = src.slice(i, i + 2500);
    assert.match(slice, /rejectMappingIfNameTooLong/);
    assert.match(slice, /if \(nameReject\) return nameReject/);
    // Behavioral: call the gate with a long name (kills if(false) inside it).
    const rejected = rejectMappingIfNameTooLong("N".repeat(256));
    assert.equal(rejected.ok, false);
    assert.equal(rejected.code, "FIELD_TOO_LONG");
    assert.match(String(rejected.error), /255/);
    assert.equal(rejectMappingIfNameTooLong("Kitchen"), null);
  });

  it("H3: client-side form name check uses codePointLen > 255", () => {
    const html = rd("index.html");
    assert.match(html, /codePointLen\(name\) > 255/);
    assert.match(html, /Name must be at most 255 characters/);
  });

  it("S2: add-discovered-printer reports failed sync", () => {
    const src = rd("src/main.js");
    const i = src.indexOf('ipcMain.handle("add-discovered-printer"');
    assert.ok(i >= 0);
    const end = src.indexOf('ipcMain.handle("set-printer-mapping"', i + 1);
    const slice = src.slice(i, end > i ? end : i + 3500);
    assert.match(slice, /sync && sync\.ok === false && !sync\.skipped/);
    assert.match(slice, /added:\s*row/);
    assert.match(slice, /Printer sync failed/);
  });

  it("S3: formatPrinterSyncValidationError uses pickPrinterFromValidationError", () => {
    const src = rd("src/printer-field-limits.js");
    const i = src.indexOf("function formatPrinterSyncValidationError");
    assert.ok(i >= 0);
    assert.match(src.slice(i, i + 500), /pickPrinterFromValidationError/);
  });

  it("W3: registry upsert stores capped external_id (fails if upsert skips cap)", () => {
    const { createPrinterRegistry } = require("../src/printer-registry");
    const raw = "win:" + "Z".repeat(300);
    const r = createPrinterRegistry();
    const row = r.upsert({ external_id: raw, name: "Z" });
    assert.equal(row.external_id, capExternalId(raw));
    assert.equal(codePointLength(row.external_id), 255);
    assert.ok(r.get(raw), "get(raw) must resolve via normalize");
    assert.ok(r.get(capExternalId(raw)));
  });
});

describe("R20D-I2 persistent sync 422 state", () => {
  const { createStationPrintingController } = require("../src/station-printing");

  it("keeps named printerSyncError until success or remove", async () => {
    let cfg = {
      agent_api_base: "https://api.example.com",
      agent_token: "tok",
      pairing_code: "",
      branch_id: "147",
      is_print_host: true,
      host_epoch: 1,
    };
    let fail = true;
    const ctrl = createStationPrintingController({
      readConfig: () => ({ ...cfg }),
      writeConfig: (p) => {
        cfg = { ...cfg, ...p };
      },
      request: async () => {
        if (fail) {
          return {
            status: 422,
            data: {
              error: {
                code: "VALIDATION_ERROR",
                message: "The given data was invalid.",
                details: {
                  "printers.0.name": [
                    "The printers.0.name may not be greater than 255 characters.",
                  ],
                },
              },
            },
            headers: {},
          };
        }
        return {
          status: 200,
          data: { printers: [] },
          headers: {},
        };
      },
      log: () => {},
      sleep: async () => {},
    });
    ctrl.policy.applyServerState({ is_print_host: true, host_epoch: 1 });
    ctrl.printers.upsert({
      external_id: "win:Sticky",
      name: "StickyPrinter",
      connection: "usb",
      status: "online",
    });
    const res = await ctrl.syncPrintersToServer({ force: true });
    assert.equal(res.ok, false);
    const st1 = ctrl.publicHostState();
    assert.ok(st1.printerSyncError);
    assert.match(String(st1.printerSyncError.message), /StickyPrinter/);
    // Persists across subsequent state reads
    assert.match(
      String(ctrl.publicHostState().printerSyncError.message),
      /StickyPrinter/
    );
    // Cleared on successful sync
    fail = false;
    const ok = await ctrl.syncPrintersToServer({ force: true });
    assert.equal(ok.ok, true);
    assert.equal(ctrl.publicHostState().printerSyncError, null);

    // Set again then clear on remove
    fail = true;
    await ctrl.syncPrintersToServer({ force: true });
    assert.ok(ctrl.publicHostState().printerSyncError);
    ctrl.removeManagedPrinter("win:Sticky");
    assert.equal(ctrl.publicHostState().printerSyncError, null);
  });

  it("settings UI renders persistent printerSyncError banner", () => {
    const fs = require("fs");
    const path = require("path");
    const html = fs.readFileSync(
      path.join(__dirname, "..", "index.html"),
      "utf8"
    );
    assert.match(html, /id="settings-printer-sync-err"/);
    assert.match(html, /printerSyncError/);
  });
});


describe("R21D-L1/L2/L3 registry + wire", () => {
  const { createPrinterRegistry } = require("../src/printer-registry");

  it("R21D-L1: bare Windows name over 251 routes to capped win: row", () => {
    const name = "P".repeat(300);
    const raw = "win:" + name;
    const r = createPrinterRegistry();
    r.upsert({ external_id: raw, name, windows_name: name });
    const hit = r.routeMessage({ printer_external_id: name });
    assert.equal(hit.ok, true);
    assert.equal(hit.printer.windows_name, name);
    assert.equal(hit.printer.external_id, capExternalId(raw));
  });

  it("R21D-L1: bare long name resolves via win: form when names were customized", () => {
    const name = "R".repeat(300);
    const raw = "win:" + name;
    const r = createPrinterRegistry();
    r.upsert({
      external_id: raw,
      name: "CustomLabel",
      windows_name: "CustomLabel",
    });
    // Job still carries the original bare Windows name; name_fallback cannot
    // match CustomLabel, so the raw→win: path must find the capped row.
    const hit = r.routeMessage({ printer_external_id: name });
    assert.equal(hit.ok, true);
    assert.equal(hit.printer.external_id, capExternalId(raw));
    assert.equal(hit.matchedBy, "external_id");
  });

  it("R21D-L1: name_fallback uses ORIGINAL bare name (not hashed id)", () => {
    // Row is NOT under win:{name} — only windows_name matches the bare id.
    const name = "Q".repeat(300);
    const r = createPrinterRegistry();
    r.upsert({
      external_id: "lan:10.0.0.9:9100",
      name: "Front",
      windows_name: name,
      connection: "lan",
    });
    const hit = r.routeMessage({ printer_external_id: name });
    assert.equal(hit.ok, true);
    assert.equal(hit.matchedBy, "name_fallback");
    assert.equal(hit.printer.external_id, "lan:10.0.0.9:9100");
  });

  it("R21D-L2 / R22D-L2 / L14-I5: invisible-only blank; keep ZWJ in emoji", () => {
    assert.equal(sanitizePrinterName("\u00a0\u200b\u2060\ufeff "), "");
    assert.equal(resolvePrinterName("\u00a0\u200b ", "lan:a:9100"), "lan:a:9100");
    assert.equal(resolvePrinterName("A  B", "id"), "A  B");
    assert.equal(resolvePrinterName("👨‍👩‍👧", "id"), "👨‍👩‍👧");
    assert.equal(resolvePrinterName("Kit\u200bchen", "id"), "Kit\u200bchen");
    const r = createPrinterRegistry();
    r.upsert({ external_id: "lan:a:9100", name: "\u00a0\u200b " });
    assert.equal(r.list()[0].name, "lan:a:9100");
    r.upsert({ external_id: "lan:b:9100", name: "A  B" });
    assert.equal(r.list().find((p) => p.external_id === "lan:b:9100").name, "A  B");
  });

  it("R22D-L1: out_of_paper keeps Out of paper detail; never null out existing", () => {
    const a = normalizeStatusFields("out_of_paper", null);
    assert.equal(a.status, "error");
    assert.equal(a.status_detail, "Out of paper");
    const b = normalizeStatusFields("paused", "Door open");
    assert.equal(b.status, "error");
    assert.equal(b.status_detail, "Door open");
    const r = createPrinterRegistry();
    r.upsert({ external_id: "lan:a:9100", name: "n", status: "out_of_paper" });
    const p = r.toSyncPayload()[0];
    assert.equal(p.status, "error");
    assert.equal(p.status_detail, "Out of paper");
  });

  it("R21D-L3 / R22D-L3: status vocab + strict port", () => {
    assert.equal(capStatus("ONLINE"), "online");
    assert.equal(capStatus("paused"), "error");
    assert.equal(capStatus(true), "error");
    assert.equal(sanitizePort(0), undefined);
    assert.equal(sanitizePort(99999), undefined);
    assert.equal(sanitizePort(9100), 9100);
    assert.equal(sanitizePort(true), undefined);
    assert.equal(sanitizePort("0x10"), undefined);
    assert.equal(sanitizePort(9100.5), undefined);
    const r = createPrinterRegistry();
    r.upsert({
      external_id: "lan:b:9100",
      name: "ok",
      status: "ONLINE",
      port: 0,
    });
    const p = r.toSyncPayload()[0];
    assert.equal(p.status, "online");
    assert.ok(!("port" in p));
  });

  it("R22D-I1: port boundaries, digit string, keep prior on invalid", () => {
    assert.equal(sanitizePort(65535), 65535);
    assert.equal(sanitizePort(65536), undefined);
    assert.equal(sanitizePort(1), 1);
    assert.equal(sanitizePort("9100"), 9100);
    assert.equal(sanitizePort("65535"), 65535);
    assert.equal(sanitizePort("65536"), undefined);
    const r = createPrinterRegistry();
    r.upsert({ external_id: "lan:c:9100", name: "n", port: 9100 });
    assert.equal(r.get("lan:c:9100").port, 9100);
    r.upsert({ external_id: "lan:c:9100", name: "n", port: 0 });
    assert.equal(r.get("lan:c:9100").port, 9100);
    r.upsert({ external_id: "lan:c:9100", name: "n", port: "9100" });
    assert.equal(r.get("lan:c:9100").port, 9100);
    r.upsert({ external_id: "lan:c:9100", name: "n", port: 65535 });
    assert.equal(r.get("lan:c:9100").port, 65535);
    r.upsert({ external_id: "lan:c:9100", name: "n", port: 65536 });
    assert.equal(r.get("lan:c:9100").port, 65535);
  });
});

describe("R22D mutations (survivor killers)", () => {
  it("I1: >65535 mutant dies — 65536 rejected, 65535 kept", () => {
    assert.equal(sanitizePort(65535), 65535);
    assert.equal(sanitizePort(65536), undefined);
    assert.equal(sanitizePort("65535"), 65535);
    assert.equal(sanitizePort("65536"), undefined);
  });

  it("I1: string-only digit ports kept (raw-number mutant dies)", () => {
    assert.equal(sanitizePort("9100"), 9100);
    assert.equal(sanitizePort("1"), 1);
  });

  it("L3: bool/hex/float rejected; invalid upsert keeps stored port", () => {
    assert.equal(sanitizePort(true), undefined);
    assert.equal(sanitizePort(false), undefined);
    assert.equal(sanitizePort("0x10"), undefined);
    assert.equal(sanitizePort(9100.5), undefined);
    assert.equal(sanitizePort("9100.0"), undefined);
    assert.equal(sanitizePort(" 9100 "), undefined);
    const r = createPrinterRegistry();
    r.upsert({ external_id: "lan:m:9100", name: "n", port: 9100 });
    r.upsert({ external_id: "lan:m:9100", name: "n", port: 0 });
    assert.equal(r.get("lan:m:9100").port, 9100);
    r.upsert({ external_id: "lan:m:9100", name: "n", port: true });
    assert.equal(r.get("lan:m:9100").port, 9100);
  });

  it("L1: known raw status fills detail; never null over existing", () => {
    const filled = normalizeStatusFields("OUT_OF_PAPER", null);
    assert.equal(filled.status, "error");
    assert.equal(filled.status_detail, "Out of paper");
    const kept = normalizeStatusFields("paused", "Door open");
    assert.equal(kept.status_detail, "Door open");
    const onlineClears = normalizeStatusFields("online", "Door open"); // not provided
    assert.equal(onlineClears.status_detail, null);
    const onlineFresh = normalizeStatusFields("online", "OK", {
      detailProvided: true,
    });
    assert.equal(onlineFresh.status_detail, "OK");
  });

  it("L2/L14-I5: ZWJ kept in emoji; invisible-only falls back", () => {
    assert.equal(resolvePrinterName("👨‍👩‍👧", "id"), "👨‍👩‍👧");
    assert.equal(resolvePrinterName("A  B", "id"), "A  B");
    assert.equal(resolvePrinterName("\u200c\u200d", "id"), "id"); // ZWNJ+ZWJ alone → blank
    assert.equal(resolvePrinterName("\u200b\u2060\ufeff", "id"), "id");
  });
});

describe("L14-I4 / L14-I5 BE v1.33 notes", () => {
  it("L14-I4: empty/whitespace port omitted; keep stored; never send 0", () => {
    assert.equal(sanitizePort(""), undefined);
    assert.equal(sanitizePort("   "), undefined);
    assert.equal(sanitizePort("\t"), undefined);
    assert.equal(sanitizePort(0), undefined);
    assert.equal(sanitizePort("0"), undefined);
    const r = createPrinterRegistry();
    r.upsert({ external_id: "lan:p:9100", name: "n", port: 9100 });
    r.upsert({ external_id: "lan:p:9100", name: "n", port: "" });
    assert.equal(r.get("lan:p:9100").port, 9100);
    r.upsert({ external_id: "lan:p:9100", name: "n", port: "  " });
    assert.equal(r.get("lan:p:9100").port, 9100);
    const wire = r.toSyncPayload()[0];
    assert.equal(wire.port, 9100);
    assert.notEqual(wire.port, 0);
  });

  it("L14-I5: ZWJ-only name falls back to id", () => {
    assert.equal(resolvePrinterName("\u200d", "lan:z:9100"), "lan:z:9100");
    const r = createPrinterRegistry();
    r.upsert({ external_id: "lan:z:9100", name: "\u200d" });
    assert.equal(r.toSyncPayload()[0].name, "lan:z:9100");
  });

  it("L14-I5: mixed invisible-only name falls back", () => {
    const mix = "\u00a0\u200b\u200c\u200d\u2060\ufeff \t";
    assert.equal(printerNameBlankCheck(mix), "");
    assert.equal(resolvePrinterName(mix, "lan:m:9100"), "lan:m:9100");
    const r = createPrinterRegistry();
    r.upsert({ external_id: "lan:m:9100", name: mix });
    assert.equal(r.toSyncPayload()[0].name, "lan:m:9100");
  });

  it("L14-I5: family emoji with ZWJ stays intact", () => {
    const family = "👨‍👩‍👧";
    assert.equal(resolvePrinterName(family, "id"), family);
    const r = createPrinterRegistry();
    r.upsert({ external_id: "lan:e:9100", name: family });
    assert.equal(r.toSyncPayload()[0].name, family);
  });
});

describe("L14 mutations (survivor killers)", () => {
  it("I4: empty-string port mutant must not wipe or emit 0", () => {
    assert.equal(sanitizePort(""), undefined);
    const r = createPrinterRegistry();
    r.upsert({ external_id: "lan:k:9100", name: "n", port: 9100 });
    r.upsert({ external_id: "lan:k:9100", name: "n", port: "" });
    assert.equal(r.get("lan:k:9100").port, 9100);
    const p = r.toSyncPayload()[0];
    assert.equal(p.port, 9100);
    // Direct 0 never on the wire
    r.upsert({ external_id: "lan:k:9100", name: "n", port: 0 });
    assert.equal(r.get("lan:k:9100").port, 9100);
    assert.equal(r.toSyncPayload()[0].port, 9100);
  });

  it("I5: ZWJ-only / ZWNJ-only blank check must fall back (keep-ZWJ mutant dies)", () => {
    assert.equal(resolvePrinterName("\u200d", "id"), "id");
    assert.equal(resolvePrinterName("\u200c", "id"), "id");
    assert.equal(resolvePrinterName("\u200d\u200c\u200d", "id"), "id");
    // Visible + ZWJ still sends original
    assert.equal(resolvePrinterName("👨\u200d👩", "id"), "👨\u200d👩");
  });
});

describe("R23D-M1 / L1 / I1", () => {
  it("R23D-M1: out_of_paper then ready clears stale detail", () => {
    const r = createPrinterRegistry();
    r.upsert({ external_id: "lan:a:9100", name: "n", status: "out_of_paper" });
    assert.equal(r.toSyncPayload()[0].status_detail, "Out of paper");
    r.upsert({ external_id: "lan:a:9100", name: "n", status: "online" });
    assert.equal(r.toSyncPayload()[0].status, "online");
    assert.equal(r.toSyncPayload()[0].status_detail, null);
  });

  it("R23D-M1: door-open then ready clears detail", () => {
    const r = createPrinterRegistry();
    r.upsert({
      external_id: "lan:a:9100",
      name: "n",
      status: "error",
      status_detail: "Door open",
    });
    r.upsert({ external_id: "lan:a:9100", name: "n", status: "online" });
    assert.equal(r.toSyncPayload()[0].status_detail, null);
  });

  it("R23D-M1: explicit status_detail null clears; absent key keeps on error", () => {
    const r = createPrinterRegistry();
    r.upsert({
      external_id: "lan:a:9100",
      name: "n",
      status: "error",
      status_detail: "Door open",
    });
    r.upsert({
      external_id: "lan:a:9100",
      name: "n",
      status: "error",
      status_detail: null,
    });
    assert.equal(r.toSyncPayload()[0].status_detail, null);
    r.upsert({
      external_id: "lan:a:9100",
      name: "n",
      status: "error",
      status_detail: "Jam",
    });
    r.upsert({ external_id: "lan:a:9100", name: "n", status: "error" });
    assert.equal(r.toSyncPayload()[0].status_detail, "Jam");
  });

  it("R23D-L1: reject leading-zero port strings; integers still ok", () => {
    assert.equal(sanitizePort("009100"), undefined);
    assert.equal(sanitizePort("0009100"), undefined);
    assert.equal(sanitizePort("9100"), 9100);
    assert.equal(sanitizePort(9100), 9100);
    assert.equal(sanitizePort("065535"), undefined);
    assert.equal(sanitizePort("65535"), 65535);
  });

  it("R23D-I1: out_of_paper with explicit detail keeps that detail (D_overwrite)", () => {
    const n = normalizeStatusFields("out_of_paper", "Tray empty", {
      detailProvided: true,
    });
    assert.equal(n.status, "error");
    assert.equal(n.status_detail, "Tray empty");
    const r = createPrinterRegistry();
    r.upsert({
      external_id: "lan:a:9100",
      name: "n",
      status: "out_of_paper",
      status_detail: "Tray empty",
    });
    assert.equal(r.toSyncPayload()[0].status_detail, "Tray empty");
  });
});

describe("R23D mutations (survivor killers)", () => {
  it("M1: online without fresh detail must clear (stale-keep mutant dies)", () => {
    const r = createPrinterRegistry();
    r.upsert({
      external_id: "lan:a:9100",
      name: "n",
      status: "error",
      status_detail: "Out of paper",
    });
    r.upsert({ external_id: "lan:a:9100", name: "n", status: "online" });
    assert.equal(r.get("lan:a:9100").status_detail, null);
  });

  it("M1: offline without fresh detail clears; Windows fresh detail kept", () => {
    const cleared = normalizeStatusFields("offline", "stale", {
      detailProvided: false,
    });
    assert.equal(cleared.status_detail, null);
    const fresh = normalizeStatusFields("offline", "offline", {
      detailProvided: true,
    });
    assert.equal(fresh.status_detail, "offline");
  });

  it("L1: leading-zero pad mutant dies", () => {
    assert.equal(sanitizePort("009100"), undefined);
    assert.equal(sanitizePort("0009100"), undefined);
    assert.equal(sanitizePort("09100"), undefined);
  });

  it("I1: D_overwrite mutant dies — explicit detail wins over known default", () => {
    const n = normalizeStatusFields("OUT_OF_PAPER", "Sensor trip", {
      detailProvided: true,
    });
    assert.equal(n.status_detail, "Sensor trip");
    assert.notEqual(n.status_detail, "Out of paper");
  });
});
