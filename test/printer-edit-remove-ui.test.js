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
});
