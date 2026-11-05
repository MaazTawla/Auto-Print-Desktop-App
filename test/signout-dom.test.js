"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");

const root = path.join(__dirname, "..");
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const MSG = "Couldn't sign this device out, please try again";

describe("R16D Sign out this device (jsdom)", () => {
  let w, d, stateCb, deregImpl, stateNow, calls, errs, toasts, confirms;

  const base = { darkMode: true, printers: [] };
  const st = (sp) => stateCb({ ...base, stationPrinting: sp });

  before(async () => {
    calls = 0;
    errs = [];
    toasts = [];
    confirms = [];
    let html = fs.readFileSync(path.join(root, "index.html"), "utf8");
    const tag = '<script src="src/pairing-ui-policy.js"></script>';
    html = html.replace(
      tag,
      "<script>" +
        fs.readFileSync(path.join(root, "src/pairing-ui-policy.js"), "utf8") +
        "</script>"
    );
    const vc = new VirtualConsole();
    vc.on("jsdomError", (e) => errs.push(String(e.message).slice(0, 200)));
    const dom = new JSDOM(html, {
      runScripts: "dangerously",
      virtualConsole: vc,
      pretendToBeVisual: true,
      beforeParse(win) {
        win.confirm = (msg) => {
          confirms.push(String(msg));
          return win.__confirmResult !== false;
        };
        win.api = new Proxy(
          {},
          {
            get: (_, k) =>
              k === "onStateUpdate"
                ? (cb) => {
                    stateCb = cb;
                  }
                : k === "deregisterPrintAgent"
                  ? async () => {
                      calls += 1;
                      return deregImpl();
                    }
                  : k === "getState"
                    ? async () => ({ ...base, stationPrinting: stateNow })
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
    w.switchTab("settings");
    const orig = w.showToast;
    w.showToast = (m, k) => {
      toasts.push([k, m]);
      try {
        if (orig) orig(m, k);
      } catch (_) {}
    };
  });

  after(() => w && w.close());

  const btn = () => d.getElementById("settings-agent-sign-out");
  const err = () => d.getElementById("settings-agent-err");

  it("R16D-I1: confirm explains branch removal; cancel sends no IPC", async () => {
    stateNow = { needsPairing: false, agentTokenConfigured: true };
    st(stateNow);
    w.__confirmResult = false;
    calls = 0;
    confirms.length = 0;
    btn().click();
    await tick();
    assert.equal(calls, 0);
    assert.ok(confirms.length >= 1);
    assert.match(confirms[0], /removes this device from the branch/i);
    assert.match(confirms[0], /pair again/i);
    w.__confirmResult = true;
  });

  it("hidden when not paired, visible when token configured", () => {
    st({ needsPairing: true, agentTokenConfigured: false });
    assert.equal(btn().hidden, true);
    st({ needsPairing: false, agentTokenConfigured: true });
    assert.equal(btn().hidden, false);
    assert.equal(btn().disabled, false);
  });

  it("busy+disabled while in flight; state pushes don't re-enable; double-click = 1 IPC", async () => {
    let release;
    deregImpl = () => new Promise((r) => (release = r));
    calls = 0;
    stateNow = { needsPairing: false, agentTokenConfigured: true };
    st(stateNow);
    w.__confirmResult = true;
    btn().click();
    await tick(5);
    assert.equal(btn().disabled, true);
    assert.equal(btn().dataset.busy, "1");
    st({ needsPairing: false, agentTokenConfigured: true });
    assert.equal(btn().disabled, true);
    btn().click();
    await tick(5);
    assert.equal(calls, 1);
    release({ ok: false, error: MSG, code: "UPDATE_CONFLICT" });
    await tick();
    assert.equal(btn().disabled, false);
    assert.equal(btn().hidden, false);
    assert.equal(err().textContent, MSG);
  });

  it("R16D-L1: success hides button immediately (not stuck visible+disabled)", async () => {
    deregImpl = async () => {
      stateNow = {
        needsPairing: true,
        agentTokenConfigured: false,
        pairingCodeConfigured: false,
      };
      return { ok: true, message: "Signed out of print agent on this device." };
    };
    stateNow = { needsPairing: false, agentTokenConfigured: true };
    st(stateNow);
    toasts.length = 0;
    w.__confirmResult = true;
    btn().click();
    await tick();
    assert.equal(err().textContent, "");
    assert.equal(btn().hidden, true, "must hide right away after success");
    assert.equal(btn().disabled, false);
    assert.equal(btn().dataset.busy, undefined);
  });

  it("R16D-I3: IPC reject shows friendly message, never raw text", async () => {
    deregImpl = async () => {
      throw new Error("boom");
    };
    stateNow = { needsPairing: false, agentTokenConfigured: true };
    st(stateNow);
    w.__confirmResult = true;
    btn().click();
    await tick();
    assert.equal(err().textContent, MSG);
    assert.equal(d.body.textContent.includes("boom"), false);
    assert.equal(btn().disabled, false);
  });

  it("confirm() is used before sign-out", () => {
    const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
    const i = html.indexOf("'settings-agent-sign-out').addEventListener");
    const body = html.slice(i, i + 1800);
    assert.match(body, /confirm\(/);
    assert.match(body, /removes this device from the branch/i);
  });

  it("no renderer errors", () => assert.deepEqual(errs, []));
});
