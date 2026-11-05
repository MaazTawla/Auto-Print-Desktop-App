"use strict";

// Real-DOM test of index.html pairing UI (port of QA's dom.js harness).
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");

const root = path.join(__dirname, "..");
const tick = () => new Promise((r) => setTimeout(r, 30));

describe("index.html pairing UI (jsdom)", () => {
  let dom, w, d, stateCb, regRes, deregRes, errs, inp, err;
  const base = { darkMode: true, printers: [], stationPrinting: { needsPairing: false, pairingCodeConfigured: true } };
  const st = (sp) => stateCb({ ...base, stationPrinting: sp });

  before(async () => {
    let html = fs.readFileSync(path.join(root, "index.html"), "utf8");
    const tag = '<script src="src/pairing-ui-policy.js"></script>';
    assert.ok(html.includes(tag), "index.html must load pairing-ui-policy.js");
    html = html.replace(tag, "<script>" + fs.readFileSync(path.join(root, "src/pairing-ui-policy.js"), "utf8") + "</script>");
    const vc = new VirtualConsole();
    errs = [];
    vc.on("jsdomError", (e) => errs.push(String(e.message).slice(0, 200)));
    dom = new JSDOM(html, {
      runScripts: "dangerously",
      virtualConsole: vc,
      pretendToBeVisual: true,
      beforeParse(win) {
        win.api = new Proxy({}, {
          get: (_, k) =>
            k === "onStateUpdate"
              ? (cb) => { stateCb = cb; }
              : k === "retryPrintHostRegister"
                ? async () => regRes
                : k === "deregisterPrintAgent"
                  ? async () => deregRes
                  : k === "getState"
                    ? async () => ({ ...base, stationPrinting: { needsPairing: false, pairingCodeConfigured: true, agentTokenConfigured: !(deregRes && deregRes.ok) } })
                    : async () => ({ ok: true }),
        });
        win.confirm = () => true; // R16D-I1: Sign out confirms before IPC
        win.matchMedia = win.matchMedia || (() => ({ matches: false, addListener() {}, addEventListener() {} }));
      },
    });
    w = dom.window;
    d = w.document;
    await tick();
    assert.equal(typeof stateCb, "function", "renderer must subscribe to state");
    // The field lives in the Settings panel (display:none until its tab is active);
    // jsdom will not focus a hidden field, so open the tab like a user would.
    w.switchTab("settings");
    inp = d.getElementById("settings-pairing-code");
    err = d.getElementById("settings-agent-err");
  });

  after(() => w && w.close());

  it("clears the dead code once on the fresh prompt, with friendly-only error text", () => {
    st(base.stationPrinting);
    inp.value = "DEAD-CODE";
    st({ needsPairing: true, pairingCodeConfigured: false, lastRegisterError: { code: "PAIRING_CODE_INVALID", message: "This pairing code is expired" } });
    assert.equal(inp.value, "");
    assert.equal(err.textContent, "This pairing code is expired");
  });

  it("does not re-clear while the prompt stays up", () => {
    inp.value = "TYPED";
    st({ needsPairing: true, pairingCodeConfigured: false });
    assert.equal(inp.value, "TYPED");
  });

  it("skips the clear while the user is typing", () => {
    st({ needsPairing: false, pairingCodeConfigured: true });
    inp.focus();
    assert.equal(d.activeElement, inp, "focus must land on the field");
    inp.value = "TYPING";
    st({ needsPairing: true, pairingCodeConfigured: false });
    assert.equal(inp.value, "TYPING");
    inp.blur();
  });

  it("Connect failure shows the friendly message only, no code prefix", async () => {
    inp.value = "NEWCODE-123";
    regRes = { ok: false, code: "PAIRING_BUSY", error: "Server busy, please try again.", pairingError: { code: "PAIRING_BUSY", message: "Server busy, please try again." } };
    d.getElementById("settings-agent-save").click();
    await tick();
    assert.equal(err.textContent, "Server busy, please try again.");
    assert.equal(inp.value, "NEWCODE-123");
    assert.equal(d.body.textContent.includes("PAIRING_BUSY"), false);
  });

  it("Retry failure shows the friendly message only", async () => {
    regRes = { ok: false, code: "PAIRING_RATE_LIMITED", pairingError: { code: "PAIRING_RATE_LIMITED", message: "Too many pairing attempts. Please wait 5 seconds, then try again." } };
    d.getElementById("settings-agent-retry").click();
    await tick();
    assert.equal(err.textContent, "Too many pairing attempts. Please wait 5 seconds, then try again.");
    assert.equal(d.body.textContent.includes("PAIRING_RATE_LIMITED"), false);
  });

  it("no renderer script errors", () => {
    assert.deepEqual(errs, []);
  });

  it("Sign out this device shows when signed in and keeps enabled on failure (confirm OK)", async () => {
    const btn = d.getElementById("settings-agent-sign-out");
    assert.ok(btn, "Sign out button must exist");
    assert.match(btn.textContent, /Sign out this device/i);
    st({ needsPairing: false, pairingCodeConfigured: false, agentTokenConfigured: true });
    assert.equal(btn.hidden, false);
    deregRes = {
      ok: false,
      error: "Couldn't sign this device out, please try again",
      code: "UPDATE_CONFLICT",
      stationPrinting: { agentTokenConfigured: true, needsPairing: false },
    };
    btn.click();
    await tick();
    assert.equal(err.textContent, "Couldn't sign this device out, please try again");
    assert.equal(btn.disabled, false, "button stays enabled after failure");
    assert.equal(btn.hidden, false);
  });
});
