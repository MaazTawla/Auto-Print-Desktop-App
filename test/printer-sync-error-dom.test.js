"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");

const root = path.join(__dirname, "..");
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

describe("R21D-I1 Settings printerSyncError UI (jsdom)", () => {
  let w, d, stateCb, errs;

  before(async () => {
    errs = [];
    let html = fs.readFileSync(path.join(root, "index.html"), "utf8");
    const tag = '<script src="src/pairing-ui-policy.js"></script>';
    if (html.includes(tag)) {
      html = html.replace(
        tag,
        "<script>" +
          fs.readFileSync(path.join(root, "src/pairing-ui-policy.js"), "utf8") +
          "</script>"
      );
    }
    const vc = new VirtualConsole();
    vc.on("jsdomError", (e) => errs.push(String(e.message).slice(0, 200)));
    const dom = new JSDOM(html, {
      runScripts: "dangerously",
      virtualConsole: vc,
      pretendToBeVisual: true,
      beforeParse(win) {
        win.api = new Proxy(
          {},
          {
            get: (_, k) =>
              k === "onStateUpdate"
                ? (cb) => {
                    stateCb = cb;
                  }
                : k === "getState"
                  ? async () => ({ darkMode: true, printers: [] })
                  : async () => ({ ok: true }),
          }
        );
        win.matchMedia =
          win.matchMedia ||
          (() => ({ matches: false, addListener() {}, addEventListener() {} }));
      },
    });
    w = dom.window;
    d = w.document;
    await tick();
    if (typeof w.switchTab === "function") w.switchTab("settings");
  });

  after(() => w && w.close());

  it("shows named 422 message in settings-printer-sync-err until cleared", async () => {
    assert.ok(typeof stateCb === "function", "onStateUpdate registered");
    const errEl = d.getElementById("settings-printer-sync-err");
    assert.ok(errEl, "banner element present");

    stateCb({
      darkMode: true,
      platform: "linux",
      stationPrinting: {
        isPrintHost: true,
        printers: [
          {
            external_id: "win:Sticky",
            name: "StickyPrinter",
            connection: "usb",
            status: "online",
          },
        ],
        printerSyncError: {
          message:
            'Could not sync printer "StickyPrinter": name was rejected (too long or invalid). Shorten it and try again.',
          code: "VALIDATION_ERROR",
          externalId: "win:Sticky",
          printerLabel: "StickyPrinter",
          field: "name",
        },
      },
    });
    await tick();
    assert.match(errEl.textContent, /StickyPrinter/);
    assert.notEqual(errEl.style.display, "none");

    stateCb({
      darkMode: true,
      platform: "linux",
      stationPrinting: {
        isPrintHost: true,
        printers: [
          {
            external_id: "win:Sticky",
            name: "StickyPrinter",
            connection: "usb",
            status: "online",
          },
        ],
        printerSyncError: null,
      },
    });
    await tick();
    assert.equal(errEl.textContent, "");
    assert.equal(errEl.style.display, "none");
  });
});
