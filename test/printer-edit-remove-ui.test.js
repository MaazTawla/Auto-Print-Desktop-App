"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

describe("printer edit/remove UI wiring", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const preload = fs.readFileSync(path.join(__dirname, "..", "src", "preload.js"), "utf8");
  const main = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");

  it("exposes removePrinter IPC and renders Edit/Remove actions", () => {
    assert.match(preload, /removePrinter:\s*\(opts\)\s*=>\s*ipcRenderer\.invoke\("remove-printer"/);
    assert.match(main, /ipcMain\.handle\("remove-printer"/);
    assert.match(html, /data-printer-action="edit"/);
    assert.match(html, /data-printer-action="remove"/);
    assert.match(html, /Remove ".*sync the change to the server/);
    assert.match(html, /function beginEditPrinter/);
  });

  it("H1: every inline <script> parses (new Function)", () => {
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    assert.ok(scripts.length >= 1, "expected inline scripts");
    const branchListeners = html.match(/settings-branch-save'\)\.addEventListener/g) || [];
    assert.equal(branchListeners.length, 1, "settings-branch-save must have exactly one listener");
    for (const [i, js] of scripts.entries()) {
      assert.doesNotThrow(() => {
        new Function(js);
      }, `inline script #${i} must parse`);
    }
  });

  it("L1: Edit opens a modal dialog, not only inline details", () => {
    assert.match(html, /id=["']printer-edit-modal["']/);
    assert.match(html, /openPrinterEditModal/);
    assert.match(html, /function beginEditPrinter/);
    assert.match(html, /printer-edit-save/);
    // beginEditPrinter must open the modal (not details.scrollIntoView)
    const begin = html.slice(html.indexOf("function beginEditPrinter"), html.indexOf("function clearPrinterEditForm"));
    assert.match(begin, /openPrinterEditModal/);
    assert.doesNotMatch(begin, /scrollIntoView/);
    assert.doesNotMatch(begin, /settings-printer-manual-details/);
  });

  it("L2: Test is gated (not canEdit || true)", () => {
    assert.doesNotMatch(html, /canEdit\s*\|\|\s*true/);
    assert.match(html, /const canTest = s\.platform === 'win32'/);
  });
});
