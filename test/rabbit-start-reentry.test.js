"use strict";

/**
 * Desktop r10 H1: startRabbit → applyBranchId → startRabbit deadlock.
 * Product helpers + a Connect harness that must reach "Connected as print host"
 * within a timeout on a fresh empty-branch register (no hang).
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  syncBranchIdFromServer,
  shouldReconnectAfterBranchApply,
  shouldFlushPendingBranchReconnect,
  createRabbitStartSerializer,
} = require("../src/rabbit-branch-sync");
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

describe("rabbit-branch-sync helpers", () => {
  it("syncBranchIdFromServer updates state + persists without reconnect hook", () => {
    const state = { branchId: "", channel: "" };
    const saved = [];
    const result = syncBranchIdFromServer(state, "147", {
      resolveRoutingKey: (tpl, id) => `orders.${id}`,
      getRoutingKeyTemplate: () => "orders.{branch_id}",
      saveUserConfig: (p) => saved.push(p),
    });
    assert.equal(result.changed, true);
    assert.equal(state.branchId, "147");
    assert.equal(state.channel, "orders.147");
    assert.deepEqual(saved, [{ branch_id: "147" }]);
  });

  it("syncBranchIdFromServer is a no-op when branch already matches", () => {
    const state = { branchId: "147", channel: "orders.147" };
    const saved = [];
    const result = syncBranchIdFromServer(state, "147", {
      resolveRoutingKey: () => "x",
      getRoutingKeyTemplate: () => "x",
      saveUserConfig: (p) => saved.push(p),
    });
    assert.equal(result.changed, false);
    assert.equal(saved.length, 0);
  });

  it("shouldReconnectAfterBranchApply is false while rabbitStarting", () => {
    assert.equal(shouldReconnectAfterBranchApply(true), false);
    assert.equal(shouldReconnectAfterBranchApply(false), true);
  });

  it("shouldFlushPendingBranchReconnect when pending and branch mismatch", () => {
    assert.equal(
      shouldFlushPendingBranchReconnect({
        pending: true,
        desiredBranch: "200",
        boundBranch: "147",
      }),
      true
    );
  });

  it("L1: shouldFlushPendingBranchReconnect is false when pending but desired equals bound", () => {
    assert.equal(
      shouldFlushPendingBranchReconnect({
        pending: true,
        desiredBranch: "147",
        boundBranch: "147",
      }),
      false
    );
  });

  it("shouldFlushPendingBranchReconnect on bound vs desired mismatch", () => {
    assert.equal(
      shouldFlushPendingBranchReconnect({
        pending: false,
        desiredBranch: "200",
        boundBranch: "147",
      }),
      true
    );
    assert.equal(
      shouldFlushPendingBranchReconnect({
        pending: false,
        desiredBranch: "147",
        boundBranch: "147",
      }),
      false
    );
    assert.equal(
      shouldFlushPendingBranchReconnect({
        pending: false,
        desiredBranch: "",
        boundBranch: "147",
      }),
      false
    );
  });
});

describe("re-entrant startRabbit on serializer", () => {
  it("nested await of runExclusive deadlocks (documents the bug class)", async () => {
    const ser = createRabbitStartSerializer();
    let settled = false;
    const p = ser
      .runExclusive(async () => {
        await ser.runExclusive(async () => {});
      })
      .then(() => {
        settled = true;
      });
    await Promise.race([p, new Promise((r) => setTimeout(r, 200))]);
    assert.equal(settled, false, "nested await must not settle");
  });

  it("re-entrant start is skipped via shouldReconnect guard — outer settles", async () => {
    const ser = createRabbitStartSerializer();
    let startCount = 0;
    let branchId = "";
    const configs = [];

    async function startRabbit() {
      return ser.runExclusive(async () => {
        startCount += 1;
        // Simulate register writing branch_id while empty locally
        configs.push({ branch_id: "147" });
        const serverBranch = "147";
        // FIXED path: sync only, never await applyBranchId→startRabbit
        const state = { branchId, channel: "" };
        const synced = syncBranchIdFromServer(state, serverBranch, {
          resolveRoutingKey: (_t, id) => `orders.${id}`,
          getRoutingKeyTemplate: () => "orders.{branch_id}",
          saveUserConfig: (p) => configs.push(p),
        });
        branchId = state.branchId;
        assert.equal(synced.changed, true);

        // applyBranchId-style: would have nested-awaited; guard skips
        async function applyBranchId(id) {
          syncBranchIdFromServer({ branchId, channel: "" }, id, {
            resolveRoutingKey: () => "",
            getRoutingKeyTemplate: () => "",
            saveUserConfig: () => {},
          });
          if (!shouldReconnectAfterBranchApply(ser.starting)) {
            return { skippedReconnect: true };
          }
          await startRabbit();
          return {};
        }
        const applied = await applyBranchId(serverBranch);
        assert.equal(applied.skippedReconnect, true);

        await new Promise((r) => setTimeout(r, 10));
        return { status: "connected", branchId };
      });
    }

    const result = await Promise.race([
      startRabbit(),
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error("timeout — re-entrant hang")), 500)
      ),
    ]);
    assert.equal(startCount, 1);
    assert.equal(result.status, "connected");
    assert.equal(result.branchId, "147");
  });

  it("concurrent outer starts are queued, not nested-awaited", async () => {
    const ser = createRabbitStartSerializer();
    const order = [];
    const a = ser.runExclusive(async () => {
      order.push("a-start");
      await new Promise((r) => setTimeout(r, 30));
      order.push("a-end");
      return "a";
    });
    const b = ser.runExclusive(async () => {
      order.push("b-start");
      await new Promise((r) => setTimeout(r, 5));
      order.push("b-end");
      return "b";
    });
    const [ra, rb] = await Promise.race([
      Promise.all([a, b]),
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error("queued starts hung")), 500)
      ),
    ]);
    assert.equal(ra, "a");
    assert.equal(rb, "b");
    assert.deepEqual(order, ["a-start", "a-end", "b-start", "b-end"]);
  });
});

describe("E2E fresh Connect empty branch → Connected as print host", () => {
  /**
   * Mirrors main.js startRabbit post-register path with the H1 fix:
   * ensureSession/register → syncBranchIdFromServer (no applyBranchId reentry)
   * → shouldConsume → mark connected. Must settle within timeout.
   */
  it("reaches Connected as print host within timeout with no local branch", async () => {
    const store = memoryStore({
      agent_api_base: "https://api.example.com",
      device_label: "Desk",
      pairing_code: "PAIR-OK",
      // intentionally no branch_id
    });
    const ctrl = createStationPrintingController({
      ...store,
      log: () => {},
      request: async () => ({
        status: 200,
        data: {
          token: "tok",
          is_print_host: true,
          host_epoch: 1,
          branch_id: 147,
          rabbit_version: "abcdef0123456789",
          rabbit: {
            host: "127.0.0.1",
            port: 5672,
            tls: false,
            username: "u",
            password: "p",
            exchange: "auto_print",
            queue: "printer.Branch.147",
            routing_key: "orders.147",
          },
        },
        headers: {},
      }),
    });

    const ser = createRabbitStartSerializer();
    const ui = { hostStatus: "Connecting…", rabbitmq: "idle" };
    const state = { branchId: "", channel: "" };

    async function connectFresh() {
      return ser.runExclusive(async () => {
        ui.rabbitmq = "connecting";
        ui.hostStatus = "Connecting…";

        const sess = await ctrl.ensureSession({ branchId: state.branchId });
        assert.equal(sess.ok, true);
        assert.equal(sess.shouldConsume, true);

        // Server wrote branch_id during register
        const cfgBranch = store.get();
        const serverBranch =
          cfgBranch.branch_id != null ? String(cfgBranch.branch_id).trim() : "";
        assert.equal(serverBranch, "147");

        // FIXED: sync in-place — never await applyBranchId→startRabbit
        const synced = syncBranchIdFromServer(state, serverBranch, {
          resolveRoutingKey: (_t, id) => `orders.${id}`,
          getRoutingKeyTemplate: () => "orders.{branch_id}",
          saveUserConfig: (p) => store.writeConfig(p),
        });
        assert.equal(synced.changed, true);
        assert.equal(state.branchId, "147");

        // Guarded applyBranchId must not re-enter
        if (!shouldReconnectAfterBranchApply(ser.starting)) {
          // expected while exclusive run holds starting=true
        } else {
          assert.fail("rabbitStarting should be true inside exclusive run");
        }

        if (!String(state.branchId || "").trim()) {
          ui.rabbitmq = "idle";
          throw new Error("No Branch ID after register");
        }

        // Broker creds present after host-only consume
        assert.equal(store.get().rabbit_host, "api.example.com");
        assert.ok(store.get().rabbit_password);

        // Simulate AMQP success (no live broker in unit test)
        await new Promise((r) => setTimeout(r, 5));
        ui.rabbitmq = "connected";
        const sp = ctrl.publicHostState();
        assert.equal(sp.isPrintHost, true);
        ui.hostStatus = "Connected as print host";
        return {
          hostStatus: ui.hostStatus,
          rabbitmq: ui.rabbitmq,
          branchId: state.branchId,
          isPrintHost: sp.isPrintHost,
        };
      });
    }

    const result = await Promise.race([
      connectFresh(),
      new Promise((_, rej) =>
        setTimeout(
          () => rej(new Error("E2E Connect hung — Connecting… never cleared")),
          1000
        )
      ),
    ]);

    assert.equal(result.hostStatus, "Connected as print host");
    assert.equal(result.rabbitmq, "connected");
    assert.equal(result.branchId, "147");
    assert.equal(result.isPrintHost, true);
    assert.notEqual(ui.hostStatus, "Connecting…");
  });

  it("broken nested applyBranchId path would hang (contrast)", async () => {
    const ser = createRabbitStartSerializer();
    let settled = false;
    async function startRabbitBroken() {
      return ser.runExclusive(async () => {
        // BUG: re-enter via applyBranchId
        await startRabbitBroken();
      });
    }
    const p = startRabbitBroken().then(() => {
      settled = true;
    });
    await Promise.race([p, new Promise((r) => setTimeout(r, 200))]);
    assert.equal(settled, false);
  });
});

describe("r11 M1 pending reconnect after skipped applyBranchId", () => {
  /**
   * Mid-start branch change: applyBranchId skips reconnect while rabbitStarting,
   * sets pending; startRabbit finally flushes an outer start so the consumer
   * ends bound to the new branch routing key.
   */
  it("flushes outer startRabbit after skip so consumer binds new branch", async () => {
    const ser = createRabbitStartSerializer();
    let pendingBranchReconnect = false;
    const state = { branchId: "147", channel: "orders.147" };
    const binds = [];
    let startCount = 0;

    async function startRabbit() {
      return ser.runExclusive(async () => {
        startCount += 1;
        let boundForThisStart = "";
        try {
          // Capture routing early (old branch) — the bad window from r11 M1
          boundForThisStart = String(state.branchId || "").trim();
          const routingKey = `orders.${boundForThisStart}`;
          binds.push({ start: startCount, branch: boundForThisStart, routingKey });

          // Simulate slow broker declare while Advanced changes branch
          await new Promise((r) => setTimeout(r, 40));
          return { bound: boundForThisStart, routingKey };
        } finally {
          // Mirror main.js: clear starting then flush pending via outer call
          // (serializer clears starting in its own finally after this returns;
          // we emulate the product order by scheduling after the exclusive run.)
          const desired = String(state.branchId || "").trim();
          const shouldFlush = shouldFlushPendingBranchReconnect({
            pending: pendingBranchReconnect,
            desiredBranch: desired,
            boundBranch: boundForThisStart,
          });
          if (shouldFlush) {
            pendingBranchReconnect = false;
            queueMicrotask(() => {
              startRabbit().catch(() => {});
            });
          }
        }
      });
    }

    async function applyBranchId(id) {
      const next = String(id || "").trim();
      state.branchId = next;
      state.channel = `orders.${next}`;
      if (!shouldReconnectAfterBranchApply(ser.starting)) {
        pendingBranchReconnect = true;
        return { ok: true, skippedReconnect: true };
      }
      await startRabbit();
      return { ok: true };
    }

    const first = startRabbit();
    // Wait until exclusive run has started (starting=true)
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(ser.starting, true);
    const applied = await applyBranchId("200");
    assert.equal(applied.skippedReconnect, true);
    assert.equal(pendingBranchReconnect, true);

    await first;
    // Allow microtask + second exclusive start to finish
    await new Promise((r) => setTimeout(r, 120));

    assert.ok(startCount >= 2, `expected follow-up start, got ${startCount}`);
    const last = binds[binds.length - 1];
    assert.equal(last.branch, "200");
    assert.equal(last.routingKey, "orders.200");
    assert.equal(state.branchId, "200");
  });
});
