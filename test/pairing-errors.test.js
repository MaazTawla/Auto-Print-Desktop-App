"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const pe = require("../src/pairing-errors");
const { createAgentApi } = require("../src/agent-api");
const { ERROR_CODES } = require("../src/agent-contract");
const { createStationPrintingController } = require("../src/station-printing");

function memoryStore(seed = {}) {
  let cfg = { ...seed };
  return {
    readConfig: () => ({ ...cfg }),
    writeConfig: (partial) => {
      cfg = { ...cfg, ...partial };
    },
    get: () => cfg,
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

  it("jitter stays within 500–1500ms", () => {
    assert.equal(pe.jitterDelayMs(() => 0), 500);
    assert.equal(pe.jitterDelayMs(() => 1), 1500);
    assert.equal(pe.jitterDelayMs(() => 0.5), 1000);
  });

  it("busy retry: exactly 4 calls and 3 pauses when always busy", async () => {
    let calls = 0;
    const sleeps = [];
    const r = await pe.runBusyRetry(
      async () => {
        calls++;
        return { ok: false, status: 409, code: "PAIRING_BUSY" };
      },
      { sleep: async (ms) => sleeps.push(ms), random: () => 0.25 }
    );
    assert.equal(calls, 4);
    assert.equal(sleeps.length, 3);
    for (const ms of sleeps) assert.ok(ms >= 500 && ms <= 1500);
    assert.equal(r.code, "PAIRING_BUSY");
  });

  it("busy retry stops on first non-busy result", async () => {
    let calls = 0;
    const r = await pe.runBusyRetry(
      async () => (++calls < 2 ? { ok: false, status: 409, code: "PAIRING_BUSY" } : { ok: true }),
      { sleep: async () => {} }
    );
    assert.equal(calls, 2);
    assert.equal(r.ok, true);
  });

  it("busy retry does not retry a non-409 PAIRING_BUSY-like result", async () => {
    let calls = 0;
    await pe.runBusyRetry(
      async () => {
        calls++;
        return { ok: false, status: 429, code: "PAIRING_RATE_LIMITED" };
      },
      { sleep: async () => {} }
    );
    assert.equal(calls, 1);
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

  it("409 PAIRING_BUSY: 4 calls, 3 jittered pauses, friendly message, no credential wipe", async () => {
    const store = memoryStore(seed());
    let calls = 0;
    const { ctrl, sleeps } = ctrlWith(store, async () => {
      calls++;
      return { status: 409, data: { error: { code: "PAIRING_BUSY", message: RAW } } };
    });
    const r = await ctrl.registerAsHost({ branchId: "147" });
    assert.equal(calls, 4);
    assert.equal(sleeps.length, 3);
    for (const ms of sleeps) assert.ok(ms >= 500 && ms <= 1500);
    assert.equal(r.ok, false);
    assert.equal(r.conflict, undefined);
    assert.equal(r.error.code, "PAIRING_BUSY");
    assert.equal(r.error.message, pe.MSG_SERVER_BUSY);
    assert.equal(store.get().rabbit_host, "mq.local");
    assert.equal(store.get().rabbit_version, "v7");
    assert.equal(store.get().pairing_code, "CODE-X");
    assert.equal(ctrl.publicHostState().hostConflict, null);
  });

  it("409 PAIRING_BUSY then success registers", async () => {
    const store = memoryStore(seed());
    let calls = 0;
    const { ctrl } = ctrlWith(store, async () => {
      calls++;
      if (calls < 3) return { status: 409, data: { error: { code: "PAIRING_BUSY" } } };
      return { status: 200, data: { token: "t", is_print_host: true, host_epoch: 2, branch_id: 147 } };
    });
    const r = await ctrl.registerAsHost({ branchId: "147" });
    assert.equal(calls, 3);
    assert.equal(r.ok, true);
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
