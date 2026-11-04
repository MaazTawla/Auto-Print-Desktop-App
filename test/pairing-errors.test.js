"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const pe = require("../src/pairing-errors");
const { createAgentApi } = require("../src/agent-api");
const { ERROR_CODES } = require("../src/agent-contract");
const { createStationPrintingController } = require("../src/station-printing");

function memoryStore(seed = {}) {
  let cfg = { ...seed };
  const writes = [];
  return {
    readConfig: () => ({ ...cfg }),
    writeConfig: (partial) => {
      writes.push({ ...partial });
      cfg = { ...cfg, ...partial };
    },
    get: () => cfg,
    writes,
  };
}

const BROKER = {
  rabbit_host: "mq.local",
  rabbit_user: "u",
  rabbit_pass: "p",
  rabbit_version: "v7",
};

function seed(extra = {}) {
  return {
    agent_api_base: "https://tawla.io/merchant/api/v1/print-agent",
    branch_id: "147",
    pairing_code: "CODE-X",
    device_label: "Desk",
    ...BROKER,
    ...extra,
  };
}

function ctrlWith(store, request, extra = {}) {
  const sleeps = [];
  const ctrl = createStationPrintingController({
    ...store,
    request,
    log: () => {},
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0.5,
    ...extra,
  });
  return { ctrl, sleeps };
}

const RAW = "RAW BACKEND TEXT do not show";

describe("pairing-errors: pure policy", () => {
  it("contract has PAIRING_RATE_LIMITED and PAIRING_BUSY", () => {
    assert.equal(ERROR_CODES.PAIRING_RATE_LIMITED, "PAIRING_RATE_LIMITED");
    assert.equal(ERROR_CODES.PAIRING_BUSY, "PAIRING_BUSY");
  });

  it("rate-limited message uses N seconds", () => {
    assert.equal(
      pe.rateLimitedMessage(12),
      "Too many pairing attempts. Please wait 12 seconds, then try again."
    );
    assert.match(pe.rateLimitedMessage(1), /wait 1 second,/);
    assert.match(pe.rateLimitedMessage(null), /wait a moment/);
    assert.match(pe.rateLimitedMessage(120), /about 2 minutes/);
  });

  it("retry-after: body wins, then header ms rounded up", () => {
    assert.equal(pe.retryAfterSeconds(7, 30000), 7);
    assert.equal(pe.retryAfterSeconds(null, 2500), 3);
    assert.equal(pe.retryAfterSeconds(0, 4000), 4);
    assert.equal(pe.retryAfterSeconds(null, null), null);
  });

  it("429 is never a rejected code, even with an INVALID code", () => {
    assert.equal(pe.isCodeRejected(429, "PAIRING_CODE_INVALID"), false);
    assert.equal(pe.isCodeRejected(429, "PAIRING_RATE_LIMITED"), false);
    assert.equal(pe.isCodeRejected(401, "PAIRING_CODE_INVALID"), true);
    assert.equal(pe.isCodeRejected(401, "PAIRING_CODE_EXPIRED"), true);
    assert.equal(pe.isCodeRejected(401, ""), true);
    assert.equal(pe.isCodeRejected(401, "HTTP_401"), true);
    assert.equal(pe.isCodeRejected(401, "SOMETHING_ELSE"), false);
    assert.equal(pe.isCodeRejected(409, "PAIRING_BUSY"), false);
  });

  it("shouldClearCode only when stored equals sent", () => {
    assert.equal(pe.shouldClearCode("X", "X"), true);
    assert.equal(pe.shouldClearCode(" X ", "X"), true);
    assert.equal(pe.shouldClearCode("Y", "X"), false);
    assert.equal(pe.shouldClearCode("", ""), false);
  });

  it("v1.23: dead retry helpers are gone", () => {
    assert.equal(pe.runBusyRetry, undefined);
    assert.equal(pe.jitterDelayMs, undefined);
    assert.equal(pe.BUSY_MAX_RETRIES, undefined);
  });

  it("v1.23/R7D-L1: budget failures = ANY 409 + BRANCH_MISMATCH", () => {
    assert.equal(pe.isBudgetFailure(409, "PAIRING_BUSY"), true);
    assert.equal(pe.isBudgetFailure(403, "BRANCH_MISMATCH"), true);
    assert.equal(pe.isBudgetFailure(409, "PRINT_HOST_ALREADY_CONFIGURED"), true);
    assert.equal(pe.isBudgetFailure(409, "PRINT_AGENT_ALREADY_REGISTERED"), true);
    assert.equal(pe.isBudgetFailure(409, "SOMETHING_ELSE"), true);
    assert.equal(pe.isBudgetFailure(409, "SYNC_CONFLICT"), true);
    assert.equal(pe.isBudgetFailure(409, ""), true);
    assert.equal(pe.isBudgetFailure(409, null), true);
    assert.equal(pe.isBudgetFailure(429, "PAIRING_RATE_LIMITED"), false);
    assert.equal(pe.isBudgetFailure(401, "PAIRING_CODE_INVALID"), false);
  });
});

describe("agent-api register error mapping (v1.21)", () => {
  function apiReturning(res) {
    return createAgentApi({
      apiBase: "https://tawla.io/merchant/api/v1/print-agent",
      request: async () => res,
    });
  }
  const fields = { appId: "a", branchId: "1", deviceLabel: "Desk", pairingCode: "C", role: "print_host" };

  it("429 reads retry_after_seconds from the body", async () => {
    const api = apiReturning({
      status: 429,
      data: { error: { code: "PAIRING_RATE_LIMITED", message: RAW, retry_after_seconds: 9 } },
      headers: { "retry-after": "30" },
    });
    const r = await api.register(fields);
    assert.equal(r.ok, false);
    assert.equal(r.code, "PAIRING_RATE_LIMITED");
    assert.equal(r.retryAfterSeconds, 9);
    assert.equal(r.conflict, undefined);
  });

  it("429 falls back to the Retry-After header and always codes as rate-limited", async () => {
    const api = apiReturning({
      status: 429,
      data: { error: { code: "PAIRING_CODE_INVALID", message: RAW } },
      headers: { "Retry-After": "5" },
    });
    const r = await api.register(fields);
    assert.equal(r.code, "PAIRING_RATE_LIMITED");
    assert.equal(r.retryAfterSeconds, 5);
  });

  it("409 PAIRING_BUSY is not a host conflict", async () => {
    const api = apiReturning({
      status: 409,
      data: { error: { code: "PAIRING_BUSY", message: RAW } },
    });
    const r = await api.register(fields);
    assert.equal(r.conflict, undefined);
    assert.equal(r.code, "PAIRING_BUSY");
  });

  it("409 with an unknown code is not a host conflict", async () => {
    const api = apiReturning({
      status: 409,
      data: { error: { code: "WHATEVER_NEW", message: RAW } },
    });
    const r = await api.register(fields);
    assert.equal(r.conflict, undefined);
    assert.equal(r.code, "WHATEVER_NEW");
  });

  it("409 PRINT_HOST_ALREADY_CONFIGURED still takes the conflict path", async () => {
    const api = apiReturning({
      status: 409,
      data: { error: { code: "PRINT_HOST_ALREADY_CONFIGURED", message: "x" } },
    });
    const r = await api.register(fields);
    assert.equal(r.conflict.code, "PRINT_HOST_ALREADY_CONFIGURED");
  });
});

describe("station-printing register: pairing errors", () => {
  it("429: friendly wait message, code kept, creds kept, no raw text", async () => {
    const store = memoryStore(seed());
    let calls = 0;
    const { ctrl } = ctrlWith(store, async () => {
      calls++;
      return {
        status: 429,
        data: { error: { code: "PAIRING_CODE_INVALID", message: RAW, retry_after_seconds: 12 } },
        headers: {},
      };
    });
    const r = await ctrl.registerAsHost({ branchId: "147" });
    assert.equal(calls, 1);
    assert.equal(r.ok, false);
    assert.equal(r.error.code, "PAIRING_RATE_LIMITED");
    assert.equal(
      r.error.message,
      "Too many pairing attempts. Please wait 12 seconds, then try again."
    );
    assert.equal(store.get().pairing_code, "CODE-X");
    assert.equal(store.get().rabbit_host, "mq.local");
    const st = ctrl.publicHostState();
    assert.equal(st.needsPairing, false);
    assert.equal(st.hostConflict, null);
    assert.ok(!JSON.stringify(st.lastRegisterError).includes(RAW));
  });

  it("409 PAIRING_BUSY: exactly 1 call, no pauses, friendly message, no credential wipe", async () => {
    const store = memoryStore(seed());
    let calls = 0;
    const { ctrl, sleeps } = ctrlWith(store, async () => {
      calls++;
      return { status: 409, data: { error: { code: "PAIRING_BUSY", message: RAW } } };
    });
    const r = await ctrl.registerAsHost({ branchId: "147" });
    assert.equal(calls, 1);
    assert.equal(sleeps.length, 0);
    assert.equal(r.ok, false);
    assert.equal(r.conflict, undefined);
    assert.equal(r.error.code, "PAIRING_BUSY");
    assert.equal(r.error.message, pe.MSG_SERVER_BUSY);
    assert.equal(store.get().rabbit_host, "mq.local");
    assert.equal(store.get().rabbit_version, "v7");
    assert.equal(store.get().pairing_code, "CODE-X");
    assert.equal(ctrl.publicHostState().hostConflict, null);
  });

  it("409 PAIRING_BUSY then a manual retry succeeds (2 calls, one per user action)", async () => {
    const store = memoryStore(seed());
    let calls = 0;
    const { ctrl } = ctrlWith(store, async () => {
      calls++;
      if (calls < 2) return { status: 409, data: { error: { code: "PAIRING_BUSY" } } };
      return { status: 200, data: { token: "t", is_print_host: true, host_epoch: 2, branch_id: 147 } };
    });
    const r1 = await ctrl.registerAsHost({ branchId: "147" });
    assert.equal(calls, 1);
    assert.equal(r1.ok, false);
    const r2 = await ctrl.registerAsHost({ branchId: "147" });
    assert.equal(calls, 2);
    assert.equal(r2.ok, true);
  });

  it("409 unknown code: generic friendly error, no credential wipe, no conflict", async () => {
    const store = memoryStore(seed());
    let calls = 0;
    const { ctrl } = ctrlWith(store, async () => {
      calls++;
      return { status: 409, data: { error: { code: "NEW_THING", message: RAW } } };
    });
    const r = await ctrl.registerAsHost({ branchId: "147" });
    assert.equal(calls, 1);
    assert.equal(r.conflict, undefined);
    assert.equal(r.error.message, pe.MSG_CONFLICT_UNKNOWN);
    assert.equal(store.get().rabbit_host, "mq.local");
    assert.equal(ctrl.publicHostState().hostConflict, null);
  });

  it("409 PRINT_HOST_ALREADY_CONFIGURED still drops broker creds (unchanged)", async () => {
    const store = memoryStore(seed());
    const { ctrl } = ctrlWith(store, async () => ({
      status: 409,
      data: { error: { code: "PRINT_HOST_ALREADY_CONFIGURED", message: "other" } },
    }));
    const r = await ctrl.registerAsHost({ branchId: "147" });
    assert.equal(r.conflict.code, "PRINT_HOST_ALREADY_CONFIGURED");
    assert.ok(!store.get().rabbit_host);
  });

  for (const [label, data] of [
    ["INVALID", { error: { code: "PAIRING_CODE_INVALID", message: RAW } }],
    ["EXPIRED", { error: { code: "PAIRING_CODE_EXPIRED", message: RAW } }],
    ["no code", {}],
  ]) {
    it(`401 ${label}: clears the sent code, prompts for a fresh one, no raw text`, async () => {
      const store = memoryStore(seed());
      const { ctrl } = ctrlWith(store, async () => ({ status: 401, data }));
      const r = await ctrl.registerAsHost({ branchId: "147" });
      assert.equal(r.ok, false);
      assert.equal(r.error.message, pe.MSG_CODE_INVALID);
      assert.equal(store.get().pairing_code, "");
      const st = ctrl.publicHostState();
      assert.equal(st.needsPairing, true);
      assert.equal(st.pairingPrompt, pe.MSG_CODE_INVALID);
      assert.ok(!JSON.stringify(st).includes(RAW));
    });
  }

  it("401 INVALID does not clear a code saved while the register was running", async () => {
    // First call (CODE-X) is rejected while the user saves CODE-Y; the
    // single-flight then re-runs with CODE-Y, which hits a 429 (never clears).
    const store2 = memoryStore(seed());
    let n = 0;
    const { ctrl: c2 } = ctrlWith(store2, async () => {
      n++;
      if (n === 1) store2.writeConfig({ pairing_code: "CODE-Y" });
      return n === 1
        ? { status: 401, data: { error: { code: "PAIRING_CODE_INVALID" } } }
        : { status: 429, data: { error: { code: "PAIRING_RATE_LIMITED", retry_after_seconds: 3 } } };
    });
    await c2.registerAsHost({ branchId: "147" });
    assert.equal(store2.get().pairing_code, "CODE-Y");
  });

  it("only one register runs at a time; concurrent caller with same code shares it", async () => {
    const store = memoryStore(seed());
    let calls = 0;
    let release;
    const gate = new Promise((r) => (release = r));
    const { ctrl } = ctrlWith(store, async () => {
      calls++;
      await gate;
      return { status: 429, data: { error: { code: "PAIRING_RATE_LIMITED", retry_after_seconds: 2 } } };
    });
    const a = ctrl.registerAsHost({ branchId: "147" });
    const b = ctrl.registerAsHost({ branchId: "147" });
    await new Promise((r) => setImmediate(r));
    assert.equal(ctrl.isRegisterInFlight(), true);
    assert.equal(calls, 1);
    release();
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(calls, 1);
    assert.equal(ra, rb);
    assert.equal(ctrl.isRegisterInFlight(), false);
  });

  it("a caller that saved a new code during an in-flight register runs once more with it", async () => {
    const store = memoryStore(seed());
    const sent = [];
    let release;
    const gate = new Promise((r) => (release = r));
    const { ctrl } = ctrlWith(store, async (cfg) => {
      sent.push(cfg.data.pairing_code);
      if (sent.length === 1) await gate;
      return { status: 429, data: { error: { code: "PAIRING_RATE_LIMITED", retry_after_seconds: 2 } } };
    });
    const a = ctrl.registerAsHost({ branchId: "147" });
    await new Promise((r) => setImmediate(r));
    store.writeConfig({ pairing_code: "CODE-Y" });
    const b = ctrl.registerAsHost({ branchId: "147" });
    release();
    await Promise.all([a, b]);
    assert.deepEqual(sent, ["CODE-X", "CODE-Y"]);
  });
});

describe("v1.21 follow-up: no-code 409, UI text, field clear", () => {
  const fs = require("fs");
  const path = require("path");
  const ui = require("../src/pairing-ui-policy");
  const { parseHostConflictError } = require("../src/agent-contract");
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

  it("parseHostConflictError: 409 with no code is not a conflict", () => {
    assert.equal(parseHostConflictError({}, 409), null);
    assert.equal(parseHostConflictError({ error: { message: "x" } }, 409), null);
    assert.equal(
      parseHostConflictError({ error: { code: "PRINT_HOST_ALREADY_CONFIGURED" } }, 409).code,
      "PRINT_HOST_ALREADY_CONFIGURED"
    );
  });

  it("register 409 with no code: generic friendly error, broker creds kept", async () => {
    const store = memoryStore(seed());
    const { ctrl } = ctrlWith(store, async () => ({ status: 409, data: { error: { message: RAW } } }));
    const r = await ctrl.registerAsHost({ branchId: "147" });
    assert.equal(r.conflict, undefined);
    assert.equal(r.error.message, pe.MSG_CONFLICT_UNKNOWN);
    assert.equal(store.get().rabbit_host, "mq.local");
    assert.equal(store.get().rabbit_version, "v7");
    assert.equal(ctrl.publicHostState().hostConflict, null);
  });

  it("errorText shows only the friendly message", () => {
    assert.equal(ui.errorText({ code: "PAIRING_BUSY", message: "Server busy" }), "Server busy");
    assert.equal(ui.errorText("plain"), "plain");
    assert.equal(ui.errorText(null, "Retry failed."), "Retry failed.");
  });

  it("index.html no longer prefixes the code on pairing errors and loads the policy", () => {
    assert.doesNotMatch(html, /code \? `\$\{code\}: \$\{msg\}`/);
    assert.doesNotMatch(html, /e\.code \? e\.code \+ ': '/);
    assert.match(html, /<script src="src\/pairing-ui-policy\.js"><\/script>/);
    assert.match(html, /PairingUiPolicy\.errorText\(e\)/);
    assert.match(html, /pairingFieldClearTracker\.update\(sp, typing\)/);
  });

  it("fresh prompt = needsPairing with no saved code", () => {
    assert.equal(ui.isFreshPairingPrompt({ needsPairing: true, pairingCodeConfigured: false }), true);
    assert.equal(ui.isFreshPairingPrompt({ needsPairing: true, pairingCodeConfigured: true }), false);
    assert.equal(ui.isFreshPairingPrompt({ needsPairing: false }), false);
    assert.equal(ui.isFreshPairingPrompt(null), false);
  });

  it("field clears once on false→true, not again while the prompt stays", () => {
    const t = ui.createFieldClearTracker();
    const off = { needsPairing: false, pairingCodeConfigured: true };
    const on = { needsPairing: true, pairingCodeConfigured: false };
    assert.equal(t.update(off, false), false);
    assert.equal(t.update(on, false), true);
    assert.equal(t.update(on, false), false);
    assert.equal(t.update(on, false), false);
    assert.equal(t.update(off, false), false);
    assert.equal(t.update(on, false), true);
  });

  it("field is not cleared while the user is typing, and not later either", () => {
    const t = ui.createFieldClearTracker();
    const on = { needsPairing: true, pairingCodeConfigured: false };
    assert.equal(t.update({ needsPairing: false }, false), false);
    assert.equal(t.update(on, true), false);
    assert.equal(t.update(on, false), false);
  });

  it("dead-code 401 moves controller state into the fresh prompt", async () => {
    const store = memoryStore(seed());
    const { ctrl } = ctrlWith(store, async () => ({ status: 401, data: { error: { code: "PAIRING_CODE_EXPIRED" } } }));
    const t = ui.createFieldClearTracker();
    assert.equal(t.update(ctrl.publicHostState(), false), false);
    await ctrl.registerAsHost({ branchId: "147" });
    assert.equal(t.update(ctrl.publicHostState(), false), true);
    assert.equal(t.update(ctrl.publicHostState(), false), false);
  });
});

describe("QA 451a1ca9 follow-up: L1, L2, I1", () => {
  const { parseRetryAfterMs } = require("../src/agent-http-retry-policy");
  const fields = { appId: "a", branchId: "1", deviceLabel: "Desk", pairingCode: "C", role: "print_host" };

  it("L1: register honours a header-only Retry-After above 120s", async () => {
    const api = createAgentApi({
      apiBase: "https://tawla.io/merchant/api/v1/print-agent",
      request: async () => ({ status: 429, data: { error: { code: "PAIRING_RATE_LIMITED" } }, headers: { "retry-after": "900" } }),
    });
    const r = await api.register(fields);
    assert.equal(r.retryAfterSeconds, 900);
    assert.match(pe.rateLimitedMessage(r.retryAfterSeconds), /about 15 minutes/);
  });

  it("L1: register header cap is just over a day (Android parity)", async () => {
    const api = createAgentApi({
      apiBase: "https://tawla.io/merchant/api/v1/print-agent",
      request: async () => ({ status: 429, data: {}, headers: { "retry-after": "99999" } }),
    });
    const r = await api.register(fields);
    assert.equal(r.retryAfterSeconds, 86401);
  });

  it("L1: default (heartbeat) parseRetryAfterMs cap stays 120s", () => {
    assert.equal(parseRetryAfterMs("900"), 120000);
  });

  it("L2: hours, later, and unsafe values", () => {
    assert.match(pe.rateLimitedMessage(3600), /about 1 hour,/);
    assert.match(pe.rateLimitedMessage(3601), /about 1 hour,/);
    assert.match(pe.rateLimitedMessage(7200), /about 2 hours,/);
    assert.match(pe.rateLimitedMessage(86400), /about 24 hours/);
    assert.equal(pe.rateLimitedMessage(86401), "Too many pairing attempts. Please try again later.");
    assert.equal(pe.rateLimitedMessage(1e12), "Too many pairing attempts. Please try again later.");
    for (const v of [Infinity, -Infinity, NaN, -5, 0, "abc", null, undefined]) {
      assert.match(pe.rateLimitedMessage(v), /wait a moment/, String(v));
    }
  });

  it("L2: body 1e12 through register gives 'try again later'", async () => {
    const store = memoryStore(seed());
    const { ctrl } = ctrlWith(store, async () => ({ status: 429, data: { error: { code: "PAIRING_RATE_LIMITED", retry_after_seconds: 1e12 } }, headers: {} }));
    const r = await ctrl.registerAsHost({ branchId: "147" });
    assert.equal(r.error.message, "Too many pairing attempts. Please try again later.");
  });

  it("I1: a throw is shared with same-code waiters (1 request)", async () => {
    const store = memoryStore(seed());
    let calls = 0;
    let release;
    const gate = new Promise((r) => (release = r));
    const { ctrl } = ctrlWith(store, async () => {
      calls++;
      await gate;
      throw new Error("network down");
    });
    const a = ctrl.registerAsHost({ branchId: "147" });
    const b = ctrl.registerAsHost({ branchId: "147" });
    release();
    const ra = await a.then(() => null, (e) => e);
    const rb = await b.then(() => null, (e) => e);
    assert.equal(calls, 1);
    assert.equal(ra.message, "network down");
    assert.equal(rb, ra);
    assert.equal(ctrl.isRegisterInFlight(), false);
  });

  it("I1: after a throw, a waiter whose code changed runs again", async () => {
    const store = memoryStore(seed());
    const sent = [];
    let release;
    const gate = new Promise((r) => (release = r));
    const { ctrl } = ctrlWith(store, async (cfg) => {
      sent.push(cfg.data.pairing_code);
      if (sent.length === 1) {
        await gate;
        throw new Error("network down");
      }
      return { status: 429, data: { error: { code: "PAIRING_RATE_LIMITED", retry_after_seconds: 2 } } };
    });
    const a = ctrl.registerAsHost({ branchId: "147" }).catch((e) => e);
    await new Promise((r) => setImmediate(r));
    store.writeConfig({ pairing_code: "CODE-Y" });
    const b = ctrl.registerAsHost({ branchId: "147" });
    release();
    await a;
    const rb = await b;
    assert.deepEqual(sent, ["CODE-X", "CODE-Y"]);
    assert.equal(rb.error.code, "PAIRING_RATE_LIMITED");
  });
});

describe("wait-text final spec boundaries", () => {
  const W = (t) => `Too many pairing attempts. Please wait ${t}, then try again.`;
  const cases = [
    [1, W("1 second")],
    [59, W("59 seconds")],
    [59.2, W("about 1 minute")], // ceil → 60s → minutes branch
    [60, W("about 1 minute")],
    [61, W("about 1 minute")],
    [89, W("about 1 minute")],
    [90, W("about 2 minutes")],
    [3569, W("about 59 minutes")],
    [3570, W("about 1 hour")],
    [3599, W("about 1 hour")],
    [3600, W("about 1 hour")],
    [3601, W("about 1 hour")],
    [5399, W("about 1 hour")],
    [5400, W("about 2 hours")],
    [86400, W("about 24 hours")],
    [86401, "Too many pairing attempts. Please try again later."],
    [1e12, "Too many pairing attempts. Please try again later."],
    ["90", W("about 2 minutes")],
  ];
  for (const [s, want] of cases) {
    it(`${s} → ${want}`, () => assert.equal(pe.rateLimitedMessage(s), want));
  }
  it("minutes branch never says 60", () => {
    for (let s = 60; s <= 86400; s++) {
      assert.doesNotMatch(pe.rateLimitedMessage(s), /about 60 minutes/, String(s));
    }
  });
  it("unsafe values → wait a moment", () => {
    for (const v of [0, -1, -0.5, NaN, Infinity, -Infinity, "abc", "", "  ", null, undefined, {}, [], true]) {
      assert.equal(pe.rateLimitedMessage(v), W("a moment"), String(v));
    }
  });
});

describe("v1.22 BRANCH_MISMATCH on register", () => {
  const MSG =
    "This pairing code belongs to a different branch. Get a new QR code or pairing code from Tawla Settings \u2192 Print host on the web, then try again.";

  it("maps to the Android message (any status, any case)", () => {
    assert.equal(pe.MSG_BRANCH_MISMATCH, MSG);
    for (const [status, code] of [[403, "BRANCH_MISMATCH"], [409, "branch_mismatch"], [422, "BRANCH_MISMATCH"]]) {
      const f = pe.friendlyRegisterError({ ok: false, status, code, message: RAW });
      assert.deepEqual(f, { code: "BRANCH_MISMATCH", message: MSG });
    }
    assert.equal(pe.isCodeRejected(403, "BRANCH_MISMATCH"), false);
    assert.equal(pe.isBusy(403, "BRANCH_MISMATCH"), false);
  });

  for (const status of [403, 409]) {
    it(`${status} BRANCH_MISMATCH: exactly 1 request, no pause, code and creds kept, no conflict`, async () => {
      const store = memoryStore(seed());
      let calls = 0;
      const { ctrl, sleeps } = ctrlWith(store, async () => {
        calls++;
        return { status, data: { error: { code: "BRANCH_MISMATCH", message: RAW } }, headers: {} };
      });
      const r = await ctrl.registerAsHost({ branchId: "147" });
      assert.equal(calls, 1);
      assert.equal(sleeps.length, 0);
      assert.equal(r.ok, false);
      assert.equal(r.conflict, undefined);
      assert.equal(r.error.code, "BRANCH_MISMATCH");
      assert.equal(r.error.message, MSG);
      assert.equal(store.get().pairing_code, "CODE-X");
      assert.equal(store.get().rabbit_host, "mq.local");
      const st = ctrl.publicHostState();
      assert.equal(st.needsPairing, false);
      assert.equal(st.hostConflict, null);
      assert.ok(!JSON.stringify(st).includes(RAW));
    });
  }

  it("after the 5th mismatch, the next 401 INVALID clears the code", async () => {
    const store = memoryStore(seed());
    let n = 0;
    const { ctrl } = ctrlWith(store, async () => {
      n++;
      return n <= 5
        ? { status: 403, data: { error: { code: "BRANCH_MISMATCH" } } }
        : { status: 401, data: { error: { code: "PAIRING_CODE_INVALID" } } };
    });
    for (let i = 0; i < 5; i++) {
      await ctrl.registerAsHost({ branchId: "147" });
      assert.equal(store.get().pairing_code, "CODE-X");
    }
    const r = await ctrl.registerAsHost({ branchId: "147" });
    assert.equal(n, 6);
    assert.equal(r.error.message, pe.MSG_CODE_INVALID);
    assert.equal(store.get().pairing_code, "");
  });
});

describe("QA 52c60f69: Android cross-check (L1, I1, I2)", () => {
  const { parseRegisterRetryAfterMs, REGISTER_RETRY_AFTER_MAX_MS } = require("../src/agent-api");
  const { parseRetryAfterMs } = require("../src/agent-http-retry-policy");
  const W = (t) => `Too many pairing attempts. Please wait ${t}, then try again.`;
  const LATER = "Too many pairing attempts. Please try again later.";

  async function viaRegister(data, headers) {
    const store = memoryStore(seed());
    const { ctrl } = ctrlWith(store, async () => ({ status: 429, data, headers }));
    const r = await ctrl.registerAsHost({ branchId: "147" });
    return r.error.message;
  }

  // Expected values are Android 6b0f43d4's (QA xcheck-android.out).
  const table = [
    ["900", W("about 15 minutes")],
    ["3600", W("about 1 hour")],
    ["7200", W("about 2 hours")],
    ["86400", W("about 24 hours")],
    ["86401", LATER],
    ["9999999999999", LATER],
  ];
  for (const [hdr, want] of table) {
    it(`header-only Retry-After ${hdr} → ${want}`, async () => {
      assert.equal(await viaRegister({ error: { code: "PAIRING_RATE_LIMITED" } }, { "retry-after": hdr }), want);
    });
  }

  it("cap constant and >12-digit rule", () => {
    assert.equal(REGISTER_RETRY_AFTER_MAX_MS, 86401000);
    assert.equal(parseRegisterRetryAfterMs("9999999999999"), 86401000);
    assert.equal(parseRegisterRetryAfterMs("999999999999"), 86401000);
    assert.equal(parseRegisterRetryAfterMs("7200"), 7200000);
    assert.equal(parseRegisterRetryAfterMs(null), null);
    assert.equal(parseRetryAfterMs("7200"), 120000);
  });

  it("heartbeat 429 keeps the default 120s cap", async () => {
    const api = createAgentApi({
      apiBase: "https://tawla.io/merchant/api/v1/print-agent",
      token: "t",
      request: async () => ({ status: 429, data: {}, headers: { "retry-after": "7200" } }),
    });
    const r = await api.heartbeat({ appId: "a", branchId: "1" });
    assert.equal(r.retryAfterMs, 120000);
  });

  it("I1: a string body value is ignored → header used", async () => {
    assert.equal(
      await viaRegister({ error: { code: "PAIRING_RATE_LIMITED", retry_after_seconds: "12" } }, { "retry-after": "900" }),
      W("about 15 minutes")
    );
    assert.equal(
      await viaRegister({ error: { code: "PAIRING_RATE_LIMITED", retry_after_seconds: "12" } }, {}),
      W("a moment")
    );
    assert.equal(pe.retryAfterSeconds("12", null), null);
    assert.equal(pe.retryAfterSeconds(12, null), 12);
    assert.equal(pe.retryAfterSeconds(1e12, null), 86401);
    assert.equal(pe.retryAfterSeconds(true, 5000), 5);
  });

  it("I2: rate-limited is checked before BRANCH_MISMATCH (Android order)", () => {
    const f = pe.friendlyRegisterError({ ok: false, status: 400, code: "PAIRING_RATE_LIMITED", retryAfterSeconds: 5 });
    assert.equal(f.code, "PAIRING_RATE_LIMITED");
    const g = pe.friendlyRegisterError({ ok: false, status: 429, code: "BRANCH_MISMATCH", retryAfterSeconds: 5 });
    assert.equal(g.code, "PAIRING_RATE_LIMITED");
    assert.equal(g.message, W("5 seconds"));
    const h = pe.friendlyRegisterError({ ok: false, status: 403, code: "BRANCH_MISMATCH" });
    assert.equal(h.code, "BRANCH_MISMATCH");
  });
});

describe("v1.23: shared failure budget — no automatic resend", () => {
  const cases = [
    ["409 PAIRING_BUSY", { status: 409, data: { error: { code: "PAIRING_BUSY" } } }],
    ["403 BRANCH_MISMATCH", { status: 403, data: { error: { code: "BRANCH_MISMATCH" } } }],
    ["409 PRINT_HOST_ALREADY_CONFIGURED", { status: 409, data: { error: { code: "PRINT_HOST_ALREADY_CONFIGURED", message: "x" } } }],
  ];
  for (const [name, resp] of cases) {
    it(`${name}: ensureSession (auto resume) does not resend the same code`, async () => {
      const store = memoryStore(seed());
      let calls = 0;
      const { ctrl, sleeps } = ctrlWith(store, async () => {
        calls++;
        return resp;
      });
      await ctrl.ensureSession({ branchId: "147" });
      assert.equal(calls, 1);
      const again = await ctrl.ensureSession({ branchId: "147" });
      await ctrl.ensureSession({ branchId: "147" });
      assert.equal(calls, 1);
      assert.equal(sleeps.length, 0);
      assert.equal(again.ok, false);
      assert.equal(again.autoRetryBlocked, true);
    });
  }

  it("busy message on the blocked result is the friendly one", async () => {
    const store = memoryStore(seed());
    const { ctrl } = ctrlWith(store, async () => ({ status: 409, data: { error: { code: "PAIRING_BUSY", message: RAW } } }));
    await ctrl.ensureSession({ branchId: "147" });
    const again = await ctrl.ensureSession({ branchId: "147" });
    assert.equal(again.pairingError.message, pe.MSG_SERVER_BUSY);
    assert.ok(!JSON.stringify(again).includes(RAW));
  });

  it("allowManualRegister (user Retry) lets exactly one more attempt through", async () => {
    const store = memoryStore(seed());
    let calls = 0;
    const { ctrl } = ctrlWith(store, async () => {
      calls++;
      return { status: 409, data: { error: { code: "PAIRING_BUSY" } } };
    });
    await ctrl.ensureSession({ branchId: "147" });
    ctrl.allowManualRegister();
    await ctrl.ensureSession({ branchId: "147" });
    assert.equal(calls, 2);
    await ctrl.ensureSession({ branchId: "147" });
    assert.equal(calls, 2);
  });

  it("a new code is sent automatically", async () => {
    const store = memoryStore(seed());
    let calls = 0;
    const { ctrl } = ctrlWith(store, async () => {
      calls++;
      return { status: 409, data: { error: { code: "PAIRING_BUSY" } } };
    });
    await ctrl.ensureSession({ branchId: "147" });
    store.writeConfig({ pairing_code: "CODE-Y" });
    await ctrl.ensureSession({ branchId: "147" });
    assert.equal(calls, 2);
  });

  it("429 and network errors are not budget failures: auto resume may resend", async () => {
    const store = memoryStore(seed());
    let calls = 0;
    const { ctrl } = ctrlWith(store, async () => {
      calls++;
      return { status: 429, data: { error: { code: "PAIRING_RATE_LIMITED", retry_after_seconds: 5 } } };
    });
    await ctrl.ensureSession({ branchId: "147" });
    await ctrl.ensureSession({ branchId: "147" });
    assert.equal(calls, 2);
  });

  it("after the budget runs out, the 401 INVALID (via manual retry) clears the code", async () => {
    const store = memoryStore(seed());
    let calls = 0;
    const { ctrl } = ctrlWith(store, async () => {
      calls++;
      if (calls === 1) return { status: 409, data: { error: { code: "PAIRING_BUSY" } } };
      return { status: 401, data: { error: { code: "PAIRING_CODE_INVALID" } } };
    });
    await ctrl.ensureSession({ branchId: "147" });
    ctrl.allowManualRegister();
    const r = await ctrl.ensureSession({ branchId: "147" });
    assert.equal(calls, 2);
    assert.equal(r.ok, false);
    assert.equal(ctrl.publicHostState().needsPairing, true);
    assert.equal(String(store.get().pairing_code || ""), "");
  });

  it("main.js retry handler re-allows a manual register", () => {
    const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "src", "main.js"), "utf8");
    assert.match(src, /sp\.clearHostConflict\(\);\s*\/\/[^\n]*\n\s*sp\.allowManualRegister\(\);/);
  });
});

describe("v1.23: 400-digit Retry-After pins the 12-digit rule", () => {
  const { parseRegisterRetryAfterMs, REGISTER_RETRY_AFTER_MAX_MS } = require("../src/agent-api");
  it("400 digits → cap and 'try again later'", async () => {
    const huge = "9".repeat(400);
    assert.equal(parseRegisterRetryAfterMs(huge), REGISTER_RETRY_AFTER_MAX_MS);
    const huge1 = "1" + "0".repeat(399);
    assert.equal(parseRegisterRetryAfterMs(huge1), REGISTER_RETRY_AFTER_MAX_MS);
    const store = memoryStore(seed());
    const { ctrl } = ctrlWith(store, async () => ({
      status: 429,
      headers: { "retry-after": huge },
      data: { error: { code: "PAIRING_RATE_LIMITED" } },
    }));
    const r = await ctrl.registerAsHost({ branchId: "147" });
    assert.equal(r.error.code, "PAIRING_RATE_LIMITED");
    assert.equal(r.error.message, pe.rateLimitedMessage(86401));
  });
});

describe("v1.23: 409 current_host is only device_label + is_online", () => {
  const { parseHostConflictError } = require("../src/agent-contract");
  const ui = require("../src/pairing-ui-policy");
  const C = (current_host) =>
    parseHostConflictError(
      { error: { code: "PRINT_HOST_ALREADY_CONFIGURED", message: "taken", ...(current_host === undefined ? {} : { current_host }) } },
      409
    );
  const SECRET_ID = "app-0f9e-SECRET-ID";

  it("new shape: no app_id / last_heartbeat_at", () => {
    const h = C({ device_label: "Front PC", is_online: true });
    assert.deepEqual(h.current_host, { device_label: "Front PC", is_online: true });
  });

  it("old server still sending app_id / last_heartbeat_at: both dropped", () => {
    const h = C({ app_id: SECRET_ID, last_heartbeat_at: "2026-11-04T10:00:00Z", device_label: "X", is_online: false });
    assert.deepEqual(Object.keys(h.current_host).sort(), ["device_label", "is_online"]);
    assert.ok(!JSON.stringify(h).includes(SECRET_ID));
  });

  for (const [name, lbl] of [["null", null], ["blank", "   "], ["missing", undefined], ["number", 7], ["object", {}]]) {
    it(`device_label ${name} → "" and banner says "Another device"`, () => {
      const h = C(lbl === undefined ? { is_online: true } : { device_label: lbl, is_online: true });
      assert.equal(h.current_host.device_label, "");
      const t = ui.hostConflictMeta(h.current_host);
      assert.match(t, /^Current host: Another device \(online\)\. /);
      assert.ok(!/null|undefined|\[object/.test(t));
    });
  }

  it("is_online missing or non-boolean → null, banner shows (Unknown)", () => {
    for (const on of [undefined, null, "yes", 1]) {
      const h = C(on === undefined ? { device_label: "Bar" } : { device_label: "Bar", is_online: on });
      assert.equal(h.current_host.is_online, null);
      assert.match(ui.hostConflictMeta(h.current_host), /^Current host: Bar \(Unknown\)\. /);
    }
    assert.match(ui.hostConflictMeta({ device_label: "Bar", is_online: false }), /Bar \(offline\)/);
  });

  it("no current_host / null / non-object → null, generic banner, no crash", () => {
    for (const v of [undefined, null, "str", 5, ["a"]]) {
      const h = C(v);
      assert.equal(h.current_host, null);
      const t = ui.hostConflictMeta(h.current_host);
      assert.ok(!t.startsWith("Current host"));
      assert.ok(!/null|undefined/.test(t));
    }
  });

  it("hostConflictMeta on a non-object host gives the generic line", () => {
    for (const v of ["str", 5, true]) assert.ok(!ui.hostConflictMeta(v).startsWith("Current host"));
  });

  it("literal 'null' label is not shown", () => {
    assert.match(ui.hostConflictMeta({ device_label: "null", is_online: true }), /Another device/);
  });

  it("banner never shows an id even if one is passed in", () => {
    const t = ui.hostConflictMeta({ app_id: SECRET_ID, device_label: "", is_online: true });
    assert.ok(!t.includes(SECRET_ID));
  });

  it("controller: app_id is not stored, logged or exposed", async () => {
    const store = memoryStore(seed());
    const logs = [];
    const ctrl = createStationPrintingController({
      ...store,
      log: (...a) => logs.push(a.join(" ")),
      request: async () => ({
        status: 409,
        headers: {},
        data: { error: { code: "PRINT_HOST_ALREADY_CONFIGURED", current_host: { app_id: SECRET_ID, last_heartbeat_at: "t", is_online: true } } },
      }),
    });
    const r = await ctrl.registerAsHost({ branchId: "147" });
    assert.equal(r.ok, false);
    const everything = JSON.stringify([store.get(), ctrl.publicHostState(), ctrl.hostConflict, r, logs]);
    assert.ok(!everything.includes(SECRET_ID));
    assert.ok(!everything.includes("last_heartbeat_at"));
  });

  it("index.html banner uses hostConflictMeta and never reads host.app_id", () => {
    const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "index.html"), "utf8");
    assert.match(src, /PairingUiPolicy\.hostConflictMeta\(conflict\.current_host\)/);
    assert.ok(!/current_host[^;\n]*app_id|host\.app_id/.test(src));
  });
});


describe("R5D: persisted blocked hash, throw restore, branch unblock, string message", () => {
  const crypto = require("node:crypto");
  const hash = (c) => crypto.createHash("sha256").update(String(c).trim(), "utf8").digest("hex");

  it("R5D-L1: budget failure persists pairing_auto_register_blocked_hash (not the code)", async () => {
    const store = memoryStore(seed());
    let calls = 0;
    const { ctrl } = ctrlWith(store, async () => {
      calls++;
      return { status: 409, data: { error: { code: "PAIRING_BUSY" } } };
    });
    await ctrl.ensureSession({ branchId: "147" });
    assert.equal(calls, 1);
    const h = store.get().pairing_auto_register_blocked_hash;
    assert.equal(h, hash("CODE-X"));
    assert.ok(!JSON.stringify(store.get()).includes("CODE-X") || store.get().pairing_code === "CODE-X");
    // Simulate relaunch: new controller reading same config
    const { ctrl: ctrl2 } = ctrlWith(store, async () => {
      calls++;
      return { status: 409, data: { error: { code: "PAIRING_BUSY" } } };
    });
    const again = await ctrl2.ensureSession({ branchId: "147" });
    assert.equal(calls, 1);
    assert.equal(again.autoRetryBlocked, true);
  });

  it("R5D-L2: manual Retry that throws restores the block (1 click → 1 request)", async () => {
    const store = memoryStore(seed());
    let calls = 0;
    const { ctrl } = ctrlWith(store, async () => {
      calls++;
      if (calls === 1) return { status: 409, data: { error: { code: "PAIRING_BUSY" } } };
      throw new Error("network down");
    });
    await ctrl.ensureSession({ branchId: "147" });
    assert.equal(calls, 1);
    ctrl.allowManualRegister();
    await assert.rejects(() => ctrl.ensureSession({ branchId: "147" }));
    assert.equal(calls, 2);
    // Auto resume must stay blocked
    await ctrl.ensureSession({ branchId: "147" });
    await ctrl.ensureSession({ branchId: "147" });
    assert.equal(calls, 2);
  });

  it("R5D-L3: main.js applyBranchId / set-branch-id call allowManualRegister", () => {
    const src = require("node:fs").readFileSync(
      require("node:path").join(__dirname, "..", "src", "main.js"),
      "utf8"
    );
    assert.match(src, /async function applyBranchId[\s\S]*?allowManualRegister\(\)/);
  });

  it("R5D-I1: non-string conflict message → generic, never [object Object]", () => {
    const { parseHostConflictError } = require("../src/agent-contract");
    const ui = require("../src/pairing-ui-policy");
    for (const bad of [{ nested: true }, 123, true, null]) {
      const h = parseHostConflictError(
        { error: { code: "PRINT_HOST_ALREADY_CONFIGURED", message: bad, current_host: { device_label: "X", is_online: true } } },
        409
      );
      assert.equal(h.message, "Another device is already configured as print host for this branch.");
      assert.ok(!/\[object Object\]|^123$/.test(h.message));
    }
    assert.equal(ui.errorText({ message: { a: 1 } }, "fallback"), "fallback");
    assert.equal(ui.errorText({ message: "  ok  " }, "fallback"), "ok");
  });
});

describe("v1.24: Bearer on re-register, PRINT_AGENT_ALREADY_REGISTERED", () => {
  it("re-register with stored token sends Authorization: Bearer and stores the new token", async () => {
    const store = memoryStore(seed({ agent_token: "old|TOKEN-SECRET", pairing_code: "CODE-NEW" }));
    let seenAuth = null;
    let seenBody = null;
    const { ctrl } = ctrlWith(store, async (req) => {
      seenAuth = req.headers && req.headers.Authorization;
      seenBody = req.data;
      return {
        status: 200,
        headers: {},
        data: {
          token: "new|ROTATED-SECRET",
          branch_id: 147,
          app_id: "ignored",
          is_print_host: true,
          host_epoch: 2,
          heartbeat_interval_seconds: 30,
          heartbeat_ttl_seconds: 90,
          rabbit_version: null,
        },
      };
    });
    const r = await ctrl.registerAsHost({ branchId: "147" });
    assert.equal(r.ok, true);
    assert.equal(seenAuth, "Bearer old|TOKEN-SECRET");
    assert.equal(store.get().agent_token, "new|ROTATED-SECRET");
    assert.equal(ctrl.api.getToken(), "new|ROTATED-SECRET");
    // Token never logged
    assert.ok(!JSON.stringify(seenBody).includes("TOKEN-SECRET"));
  });

  it("first pair (no token) still sends no Authorization header", async () => {
    const store = memoryStore(seed());
    let seenAuth = "MISSING";
    const { ctrl } = ctrlWith(store, async (req) => {
      seenAuth = req.headers && req.headers.Authorization;
      return {
        status: 200,
        headers: {},
        data: {
          token: "1|fresh",
          branch_id: 147,
          is_print_host: true,
          host_epoch: 1,
          heartbeat_interval_seconds: 30,
          heartbeat_ttl_seconds: 90,
          rabbit_version: null,
        },
      };
    });
    const r = await ctrl.registerAsHost({ branchId: "147" });
    assert.equal(r.ok, true);
    assert.equal(seenAuth, undefined);
  });

  it("PRINT_AGENT_ALREADY_REGISTERED: show server message, block auto-resend, keep credentials", async () => {
    const MSG =
      "This device is already paired with this branch. Ask an admin to deregister it in Settings → Printing → Print devices, then pair again.";
    const store = memoryStore(
      seed({ agent_token: "", pairing_code: "CODE-X", rabbit_host: "mq.local", rabbit_version: "v7" })
    );
    let calls = 0;
    const { ctrl } = ctrlWith(store, async () => {
      calls++;
      return {
        status: 409,
        data: { error: { code: "PRINT_AGENT_ALREADY_REGISTERED", message: MSG } },
      };
    });
    const r = await ctrl.ensureSession({ branchId: "147" });
    assert.equal(r.ok, false);
    assert.equal(calls, 1);
    assert.match(r.pairingError.message, /already paired/);
    assert.match(r.pairingError.message, /deregister/i);
    assert.match(r.pairingError.message, /Print devices/);
    // Not a host conflict — broker creds / flags stay
    assert.equal(ctrl.hostConflict, null);
    assert.equal(store.get().rabbit_host, "mq.local");
    // Auto-resend blocked (budget)
    await ctrl.ensureSession({ branchId: "147" });
    assert.equal(calls, 1);
  });

  it("PRINT_AGENT_ALREADY_REGISTERED does not wipe token when one was sent", async () => {
    const store = memoryStore(seed({ agent_token: "keep|ME", pairing_code: "CODE-X" }));
    const { ctrl } = ctrlWith(store, async () => ({
      status: 409,
      data: {
        error: {
          code: "PRINT_AGENT_ALREADY_REGISTERED",
          message: "This device is already paired with this branch. Ask an admin to deregister it in Settings → Printing → Print devices, then pair again.",
        },
      },
    }));
    const r = await ctrl.registerAsHost({ branchId: "147" });
    assert.equal(store.get().agent_token, "keep|ME");
    assert.equal(ctrl.api.getToken(), "keep|ME");
    // R7D-I1: hint shown even when a (rejected) token was presented
    assert.match(r.pairingError.message, /Print devices/);
    assert.match(r.pairingError.message, /lost its login|deregister/i);
  });

  it("ensureSession with pairing code + token prefers register (Bearer) over heartbeat", async () => {
    const store = memoryStore(seed({ agent_token: "old|T", pairing_code: "SCAN-ME" }));
    let paths = [];
    const { ctrl } = ctrlWith(store, async (req) => {
      paths.push(String(req.url || ""));
      if (String(req.url || "").includes("/register")) {
        assert.equal(req.headers.Authorization, "Bearer old|T");
        return {
          status: 200,
          headers: {},
          data: {
            token: "new|T",
            branch_id: 147,
            is_print_host: true,
            host_epoch: 1,
            heartbeat_interval_seconds: 30,
            heartbeat_ttl_seconds: 90,
            rabbit_version: null,
          },
        };
      }
      return { status: 200, headers: {}, data: { is_print_host: true, host_epoch: 1 } };
    });
    const r = await ctrl.ensureSession({ branchId: "147" });
    assert.equal(r.ok, true);
    assert.ok(paths.some((p) => p.includes("/register")));
    assert.ok(!paths.some((p) => p.includes("/heartbeat")));
  });

  it("revoked token mid-register: 409 AGENT_ALREADY_REGISTERED blocks; no loop", async () => {
    const store = memoryStore(seed({ agent_token: "revoked|X", pairing_code: "CODE-X" }));
    let calls = 0;
    const { ctrl } = ctrlWith(store, async () => {
      calls++;
      return {
        status: 409,
        data: {
          error: {
            code: "PRINT_AGENT_ALREADY_REGISTERED",
            message: "This device is already paired with this branch. Ask an admin to deregister it in Settings → Printing → Print devices, then pair again.",
          },
        },
      };
    });
    await ctrl.ensureSession({ branchId: "147" });
    await ctrl.ensureSession({ branchId: "147" });
    await ctrl.ensureSession({ branchId: "147" });
    assert.equal(calls, 1);
  });
});


describe("R7D + BE v1.25 pairing fixes", () => {
  const AE_DEFAULT =
    "This device is already paired with this branch. Ask an admin to deregister it in Settings → Printing → Print devices, then pair again.";

  it("R7D-L1: any register 409 blocks auto-resend and keeps credentials", async () => {
    const bodies = [
      { error: { code: "WHATEVER" } },
      {},
      "",
      { error: { code: "SYNC_CONFLICT" } },
    ];
    for (const data of bodies) {
      const store = memoryStore(seed({ rabbit_host: "mq.keep", rabbit_version: "v7" }));
      let calls = 0;
      const { ctrl } = ctrlWith(store, async () => {
        calls++;
        return { status: 409, data };
      });
      await ctrl.ensureSession({ branchId: "147" });
      await ctrl.ensureSession({ branchId: "147" });
      assert.equal(calls, 1, JSON.stringify(data));
      assert.equal(store.get().rabbit_host, "mq.keep");
      assert.equal(ctrl.hostConflict, null);
    }
  });

  it("R7D-L2: two Retries then network error still re-blocks", async () => {
    const BUSY = { status: 409, data: { error: { code: "PAIRING_BUSY" } } };
    let n = 0;
    const store = memoryStore(seed());
    const { ctrl } = ctrlWith(store, async () => {
      n++;
      if (n === 1) return BUSY;
      if (n === 2) throw new Error("ECONNRESET");
      return BUSY;
    });
    await ctrl.ensureSession({ branchId: "147" });
    assert.match(store.get().pairing_auto_register_blocked_hash, /^[0-9a-f]{64}$/);
    ctrl.allowManualRegister();
    ctrl.allowManualRegister(); // second Retry must not wipe restore hash
    await assert.rejects(() => ctrl.ensureSession({ branchId: "147" }));
    assert.match(store.get().pairing_auto_register_blocked_hash, /^[0-9a-f]{64}$/);
    await ctrl.ensureSession({ branchId: "147" });
    assert.equal(n, 2); // auto attempt blocked
  });

  it("R7D-L3: parseAgentError string-only for PRINT_AGENT_ALREADY_REGISTERED", () => {
    const { parseAgentError } = require("../src/agent-contract");
    for (const m of [{ a: 1 }, 123, "  ", undefined, null]) {
      const e = parseAgentError(
        { error: { code: "PRINT_AGENT_ALREADY_REGISTERED", message: m } },
        409
      );
      assert.equal(e.code, "PRINT_AGENT_ALREADY_REGISTERED");
      assert.equal(e.message, AE_DEFAULT);
      assert.ok(!/object Object|123/.test(e.message));
    }
    const ok = parseAgentError(
      { error: { code: "PRINT_AGENT_ALREADY_REGISTERED", message: "Server says X." } },
      409
    );
    assert.equal(ok.message, "Server says X.");
  });

  it("R7D-L3 end-to-end: non-string AE message shows default, never [object Object]", async () => {
    for (const m of [{ a: 1 }, 123, "  "]) {
      const store = memoryStore(seed({ agent_token: "" }));
      const { ctrl } = ctrlWith(store, async () => ({
        status: 409,
        data: { error: { code: "PRINT_AGENT_ALREADY_REGISTERED", message: m } },
      }));
      const r = await ctrl.ensureSession({ branchId: "147" });
      assert.ok(!/object Object|123/.test(r.pairingError.message));
      assert.match(r.pairingError.message, /already paired/);
      assert.match(r.pairingError.message, /Print devices/);
    }
  });

  it("R7D-L4: token + cleared code saved in ONE writeConfig", async () => {
    const store = memoryStore(seed({ pairing_code: "CODE-X", agent_token: "" }));
    const { ctrl } = ctrlWith(store, async () => ({
      status: 200,
      headers: {},
      data: {
        token: "new|SECRET-TOKEN",
        branch_id: 147,
        is_print_host: true,
        host_epoch: 1,
        heartbeat_interval_seconds: 30,
        heartbeat_ttl_seconds: 90,
        rabbit_version: null,
      },
    }));
    await ctrl.registerAsHost({ branchId: "147" });
    const tokenWrites = store.writes.filter((w) => Object.prototype.hasOwnProperty.call(w, "agent_token"));
    const codeClears = store.writes.filter((w) => w.pairing_code === "");
    assert.equal(tokenWrites.length, 1);
    assert.ok(tokenWrites[0].pairing_code === "");
    assert.equal(store.get().agent_token, "new|SECRET-TOKEN");
    assert.equal(store.get().pairing_code, "");
    // No separate token-only write before the combined one
    assert.equal(codeClears.length, 1);
  });

  it("R7D-I1: lost-token hint on AGENT_EXISTS even when a token was presented", async () => {
    const TOK = "stale|SECRET";
    const store = memoryStore(seed({ agent_token: TOK, pairing_code: "CODE-X" }));
    const logs = [];
    const { ctrl } = ctrlWith(
      store,
      async () => ({
        status: 409,
        data: { error: { code: "PRINT_AGENT_ALREADY_REGISTERED", message: "Server says X." } },
      }),
      { log: (m) => logs.push(String(m)) }
    );
    const r = await ctrl.ensureSession({ branchId: "147" });
    assert.match(r.pairingError.message, /^Server says X\./);
    assert.match(r.pairingError.message, /Print devices/);
    assert.equal(store.get().agent_token, TOK);
  });

  it("R7D-I2: token never in logs; hint NOT added for non-AE errors", async () => {
    const TOK = "leak|CHECK-ME";
    const cases = [
      { status: 409, data: { error: { code: "PAIRING_BUSY" } }, hint: false },
      { status: 401, data: { error: { code: "PAIRING_CODE_INVALID", message: "nope" } }, hint: false },
      {
        status: 409,
        data: {
          error: {
            code: "PRINT_HOST_ALREADY_CONFIGURED",
            message: "host taken",
            current_host: { device_label: "Kitchen", is_online: true },
          },
        },
        hint: false,
      },
    ];
    for (const c of cases) {
      const logs = [];
      const states = [];
      const store = memoryStore(seed({ agent_token: TOK, pairing_code: "CODE-X" }));
      const { ctrl } = ctrlWith(
        store,
        async () => c,
        {
          log: (m) => logs.push(String(m)),
          onStateChange: (st) => states.push(JSON.stringify(st)),
        }
      );
      await ctrl.ensureSession({ branchId: "147" }).catch(() => {});
      const all = logs.join("\n") + states.join("");
      assert.ok(!all.includes(TOK), "token leaked for " + JSON.stringify(c.data));
      if (c.hint === false) {
        const msg =
          (ctrl.lastRegisterError && ctrl.lastRegisterError.message) ||
          (ctrl.hostConflict && ctrl.hostConflict.message) ||
          "";
        assert.ok(!/lost its login/.test(msg), "hint wrongly added: " + msg);
      }
    }
  });

  it("v1.25: AE default + hint point to Settings → Printing → Print devices", () => {
    assert.match(pe.MSG_AGENT_ALREADY_REGISTERED, /Print devices/);
    assert.match(pe.HINT_AGENT_ALREADY_REGISTERED, /Print devices/);
    const f = pe.friendlyRegisterError({
      ok: false,
      status: 409,
      code: "PRINT_AGENT_ALREADY_REGISTERED",
      error: { message: "" },
    });
    assert.equal(f.message, pe.MSG_AGENT_ALREADY_REGISTERED);
    assert.match(f.lostTokenHint, /Print devices/);
  });

  it("v1.25: demoted host 401 clears auth via existing path; fresh code pairs; no AE loop", async () => {
    // After Change print host the former host's token is revoked → 401 on heartbeat.
    // clearLocalAuth + needsPairing; next register with a fresh code succeeds (BE deregistered it).
    const store = memoryStore(
      seed({ agent_token: "old|HOST", pairing_code: "", is_print_host: true })
    );
    let phase = "hb401";
    let regs = 0;
    const { ctrl } = ctrlWith(store, async (req) => {
      const url = String(req.url || "");
      if (phase === "hb401" && url.includes("/heartbeat")) {
        return { status: 401, data: { error: { code: "UNAUTHORIZED", message: "revoked" } } };
      }
      if (url.includes("/register")) {
        regs++;
        return {
          status: 200,
          headers: {},
          data: {
            token: "new|OBSERVER",
            branch_id: 147,
            is_print_host: false,
            host_epoch: 5,
            heartbeat_interval_seconds: 30,
            heartbeat_ttl_seconds: 90,
            rabbit_version: null,
          },
        };
      }
      return { status: 200, headers: {}, data: { is_print_host: false, host_epoch: 5 } };
    });
    ctrl.api.setToken("old|HOST");
    const hb = await ctrl.heartbeat({ branchId: "147" });
    assert.equal(hb.needsPairing || hb.authError, true);
    assert.equal(store.get().agent_token, "");
    assert.equal(ctrl.needsPairing, true);
    // Demoted host 401 must stop Rabbit/AMQP (clearLocalAuth → consumeEnabled false + broker wipe).
    assert.equal(hb.shouldConsume, false);
    assert.equal(ctrl.shouldConsume(), false);
    assert.equal(store.get().rabbit_host, "");
    assert.equal(store.get().rabbit_password || "", "");
    assert.equal(store.get().rabbit_version || "", "");
    // Fresh code — register once, no AE 409 loop
    store.writeConfig({ pairing_code: "FRESH-CODE" });
    phase = "reg";
    const r1 = await ctrl.ensureSession({ branchId: "147" });
    assert.equal(r1.ok, true);
    assert.equal(regs, 1);
    const r2 = await ctrl.ensureSession({ branchId: "147" }); // heartbeat path (code cleared)
    assert.equal(regs, 1);
    assert.equal(r2.ok, true);
  });
});
