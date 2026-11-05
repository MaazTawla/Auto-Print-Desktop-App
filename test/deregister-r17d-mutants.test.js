"use strict";

/**
 * R17D tracked mutants that FE missed at d7c35bc (QA killed them):
 *   RA1  — Retry-After cap raised to 120s
 *   RA6  — Retry-After applied to 503
 *   RA9  — HTTP-date far-future not capped
 *   N-noClear — no-token path skips clearLocalAuth
 *   N-memTok — in-memory token ignored (cfg empty → skip POST)
 */
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { createStationPrintingController } = require("../src/station-printing");

const R = (status, data, headers = {}) => ({ status, data, headers });

function mk(responder, extra = {}) {
  let cfg = {
    agent_api_base: "https://api.example.com",
    agent_token: "tok",
    pairing_code: "PAIR",
    branch_id: "147",
    is_print_host: true,
    host_epoch: 3,
    pairing_auto_register_blocked_hash: "block-hash",
    ...extra,
  };
  const calls = [];
  const sleeps = [];
  const ctrl = createStationPrintingController({
    readConfig: () => ({ ...cfg }),
    writeConfig: (partial) => {
      cfg = { ...cfg, ...partial };
    },
    request: async (q) => {
      calls.push(q);
      return responder(calls.length, q);
    },
    log: () => {},
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  ctrl.policy.applyServerState({
    is_print_host: Boolean(cfg.is_print_host),
    host_epoch: cfg.host_epoch || 3,
  });
  return { ctrl, calls, sleeps, cfg: () => cfg };
}

describe("R17D mutants: Retry-After scope and cap", () => {
  it("RA1: values above 10s are capped at 10000 (not 120000)", async () => {
    // Mutation: DEREGISTER_RETRY_AFTER_MAX_MS = 120000 → "11" would sleep 11000.
    for (const ra of ["11", "60", "999999"]) {
      const t = mk(() => R(429, {}, { "retry-after": ra }));
      await t.ctrl.deregister();
      assert.deepEqual(t.sleeps, [10000, 10000], `ra=${ra}`);
      assert.equal(t.calls.length, 3);
    }
  });

  it("RA6: Retry-After on 503 is ignored (429 only)", async () => {
    // Mutation: if (status !== 429 && status !== 503) → sleeps become [9000, 9000].
    const t = mk(() => R(503, {}, { "retry-after": "9" }));
    await t.ctrl.deregister();
    assert.deepEqual(t.sleeps, [1000, 3000]);
    assert.equal(t.calls.length, 3);
  });

  it("RA9: far-future HTTP-date Retry-After is capped at 10000", async () => {
    // Mutation: parseRetryAfterMs without Math.min(maxMs, …) for dates → ~86400000.
    const far = new Date(Date.now() + 86400 * 1000).toUTCString();
    const t = mk(() => R(429, {}, { "retry-after": far }));
    await t.ctrl.deregister();
    assert.deepEqual(t.sleeps, [10000, 10000]);
  });
});

describe("R17D mutants: no-token clear and in-memory token", () => {
  it("N-noClear: empty/whitespace token still clearLocalAuth (code, host, block-hash)", async () => {
    // Mutation: return alreadySignedOut without clearLocalAuth → pairing_code stays.
    for (const tok of ["", "   "]) {
      const t = mk(() => R(200, {}), {
        agent_token: tok,
        pairing_code: "PAIR2",
        pairing_auto_register_blocked_hash: "abc",
        is_print_host: true,
      });
      const r = await t.ctrl.deregister();
      assert.equal(t.calls.length, 0, `tok=${JSON.stringify(tok)}`);
      assert.equal(r.ok, true);
      assert.equal(r.alreadySignedOut, true);
      assert.equal(t.cfg().agent_token, "");
      assert.equal(t.cfg().pairing_code, "", "must clear pairing_code");
      assert.equal(t.cfg().is_print_host, false, "must clear is_print_host");
      assert.equal(
        t.cfg().pairing_auto_register_blocked_hash,
        "",
        "must clear block-hash"
      );
    }
  });

  it("N-memTok: in-memory token (cfg empty) still POSTs deregister", async () => {
    // Mutation: only read cfg.agent_token (ignore api.getToken()) → 0 POSTs.
    const t = mk(() => R(200, {}), { agent_token: "" });
    t.ctrl.api.setToken("mem-tok");
    const r = await t.ctrl.deregister();
    assert.equal(t.calls.length, 1, "must POST with in-memory token");
    assert.equal(r.ok, true);
    assert.equal(t.cfg().agent_token, "");
  });
});
