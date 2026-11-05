"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { createStationPrintingController } = require("../src/station-printing");

const MSG = "Couldn't sign this device out, please try again";
const R = (status, data, headers = {}) => ({ status, data, headers });

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

function mk(responder, extra = {}) {
  const store = memoryStore({
    agent_api_base: "https://api.example.com",
    agent_token: "tok",
    pairing_code: "PAIR",
    branch_id: "147",
    is_print_host: true,
    host_epoch: 7,
    ...extra,
  });
  const calls = [];
  const sleeps = [];
  const ctrl = createStationPrintingController({
    ...store,
    request: async (q) => {
      calls.push(q);
      return responder(calls.length, q);
    },
    log: () => {},
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  ctrl.policy.applyServerState({ is_print_host: true, host_epoch: 7 });
  return { ctrl, store, calls, sleeps };
}

describe("R16D deregister retries and no-token", () => {
  it("R16D-I4: 408 is retryable (3 attempts, [1000,3000])", async () => {
    const { ctrl, store, calls, sleeps } = mk(() =>
      R(408, { error: { code: "REQUEST_TIMEOUT", message: "Request failed (408)" } })
    );
    const res = await ctrl.deregister();
    assert.equal(calls.length, 3);
    assert.deepEqual(sleeps, [1000, 3000]);
    assert.equal(res.ok, false);
    assert.equal(res.message, MSG);
    assert.equal(store.get().agent_token, "tok");
  });

  it("R16D-I2: 429 Retry-After honoured and capped at 10s", async () => {
    // Mutation: ignoring Retry-After keeps [1000, 3000].
    const { ctrl, store, calls, sleeps } = mk(() =>
      R(429, { error: { code: "RATE_LIMITED" } }, { "retry-after": "10" })
    );
    const res = await ctrl.deregister();
    assert.equal(calls.length, 3);
    assert.deepEqual(sleeps, [10000, 10000]);
    assert.equal(res.ok, false);
    assert.equal(res.message, MSG);
    assert.equal(store.get().agent_token, "tok");
  });

  it("R16D-I2: 429 Retry-After below base still uses at least base backoff", async () => {
    const t = mk(() => R(429, {}, { "retry-after": "1" }));
    await t.ctrl.deregister();
    assert.deepEqual(t.sleeps, [1000, 3000]);
  });

  it("R16D-I5: no token skips POST and reports already signed out", async () => {
    let posts = 0;
    const store = memoryStore({
      agent_api_base: "https://api.example.com",
      agent_token: "",
      pairing_code: "",
      branch_id: "147",
      is_print_host: false,
      host_epoch: 1,
    });
    const ctrl = createStationPrintingController({
      ...store,
      request: async () => {
        posts += 1;
        return R(401, {});
      },
      log: () => {},
      sleep: async () => {},
    });
    const res = await ctrl.deregister();
    assert.equal(posts, 0, "must not POST without a token");
    assert.equal(res.ok, true);
    assert.equal(res.alreadySignedOut, true);
    assert.equal(res.needsPairing, true);
    assert.equal(store.get().agent_token, "");
  });

  it("R16D-I5 mutation: empty token after success does not POST again", async () => {
    let n = 0;
    const { ctrl, store, calls } = mk(() => {
      n += 1;
      return R(200, {});
    });
    assert.equal((await ctrl.deregister()).ok, true);
    assert.equal(store.get().agent_token, "");
    const before = calls.length;
    const r2 = await ctrl.deregister();
    assert.equal(r2.ok, true);
    assert.equal(r2.alreadySignedOut, true);
    assert.equal(calls.length, before, "second call must not hit the network");
  });
});

describe("R15D-L1 quit must not deregister", () => {
  it("before-quit handler has no deregister call (mutation: re-adding it fails)", () => {
    const main = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
    const i = main.indexOf('app.on("before-quit"');
    assert.ok(i > 0);
    const body = main.slice(i, i + 700);
    assert.doesNotMatch(body, /\.deregister\s*\(/);
    assert.match(body, /stopRabbit/);
    assert.match(body, /R15D-L1/);
  });

  it("wiring: only Sign out IPC path calls controller.deregister", () => {
    const main = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
    const ipc = main.indexOf('ipcMain.handle("deregister-print-agent"');
    assert.ok(ipc > 0);
    assert.match(main.slice(ipc, ipc + 500), /sp\.deregister\(\)/);
    const quit = main.indexOf('app.on("before-quit"');
    assert.doesNotMatch(main.slice(quit, quit + 700), /getStationPrinting\(\)\.deregister/);
  });

  it("credentials survive a quit-shaped lifecycle (no deregister); relaunch resumes", async () => {
    // Mutation: if before-quit called deregister and cleared on 2xx, token would be gone.
    // Quit path no longer calls deregister — credentials must remain for ensureSession.
    let cfg = {
      agent_api_base: "https://api.example.com",
      agent_token: "tok-survive",
      pairing_code: "PAIR",
      branch_id: "147",
      is_print_host: true,
      host_epoch: 3,
    };
    let posts = 0;
    const mkCtrl = () =>
      createStationPrintingController({
        readConfig: () => ({ ...cfg }),
        writeConfig: (partial) => {
          cfg = { ...cfg, ...partial };
        },
        request: async () => {
          posts += 1;
          return R(200, { is_print_host: true, host_epoch: 3 });
        },
        log: () => {},
        sleep: async () => {},
      });
    const c1 = mkCtrl();
    assert.equal(c1.api.getToken(), "tok-survive");
    // Simulate quit: drop controller without calling deregister (matches before-quit).
    const c2 = mkCtrl();
    assert.equal(cfg.agent_token, "tok-survive");
    assert.equal(c2.api.getToken(), "tok-survive");
    assert.equal(posts, 0, "quit must not have POSTed deregister");
  });
});
