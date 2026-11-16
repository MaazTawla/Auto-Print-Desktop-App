"use strict";

/**
 * v3.2 Channel-closed loop: binding a missing orders.print exchange 404s
 * and closes the live channel before consume. Bind only auto_print (plus
 * the configured exchange), surface bind errors, and do not re-bind on
 * the live channel.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const MAIN = path.join(__dirname, "..", "src", "main.js");

function mainSrc() {
  return fs.readFileSync(MAIN, "utf8");
}

function startRabbitBody(src) {
  const start = src.indexOf("async function startRabbit(");
  assert.ok(start >= 0, "startRabbit not found");
  const end = src.indexOf("\nfunction _extractOrderIdFromPayload", start);
  assert.ok(end > start, "end of startRabbit not found");
  return src.slice(start, end);
}

function loadBindHelpers() {
  const src = mainSrc();
  const start = src.indexOf("function branchBindingKeys");
  const end = src.indexOf("async function withTempRabbitChannel");
  assert.ok(start >= 0 && end > start, "bind helpers not found in main.js");
  // new Function keeps Array in this realm so deepEqual works.
  return new Function(
    `${src.slice(start, end)}\nreturn { branchBindingKeys, exchangesToBind, bindBranchQueue };`
  )();
}

function mockChannel({ missingExchanges = [] } = {}) {
  const calls = { bindQueue: [], checkQueue: [], consume: [] };
  let closed = false;
  const closeWith = (msg) => {
    closed = true;
    const err = new Error(msg);
    throw err;
  };
  return {
    calls,
    get closed() {
      return closed;
    },
    async bindQueue(queue, exchange, key) {
      calls.bindQueue.push({ queue, exchange, key });
      if (closed) closeWith("Channel closed");
      if (missingExchanges.includes(exchange)) {
        closeWith(`NOT_FOUND - no exchange '${exchange}' in vhost '/'`);
      }
    },
    async checkQueue(queue) {
      calls.checkQueue.push(queue);
      if (closed) closeWith("Channel closed");
      return { queue, messageCount: 0, consumerCount: 0 };
    },
    async consume(queue, _onMsg, _opts) {
      calls.consume.push(queue);
      if (closed) closeWith("Channel closed");
      return { consumerTag: "ctag-test" };
    },
  };
}

/** Mirrors the live start path after ensureHostPrintQueue: check, then consume. */
async function attachLiveConsumer(liveChannel, queueName) {
  await liveChannel.checkQueue(queueName);
  return liveChannel.consume(queueName, async () => {}, {
    exclusive: false,
    noAck: false,
  });
}

describe("exchangesToBind", () => {
  const { exchangesToBind } = loadBindHelpers();

  it("does not include orders.print", () => {
    assert.equal(exchangesToBind("auto_print").includes("orders.print"), false);
    assert.equal(exchangesToBind("").includes("orders.print"), false);
    // Only present when an operator explicitly configured that name.
    assert.deepEqual(exchangesToBind("orders.print"), ["orders.print", "auto_print"]);
    assert.deepEqual(exchangesToBind("auto_print"), ["auto_print"]);
  });

  it("includes the configured exchange and auto_print", () => {
    const list = exchangesToBind("custom.ex");
    assert.deepEqual(list, ["custom.ex", "auto_print"]);
  });
});

describe("bindBranchQueue", () => {
  const { bindBranchQueue } = loadBindHelpers();

  it("binds auto_print keys and never binds orders.print", async () => {
    const ch = mockChannel();
    const bound = await bindBranchQueue(
      ch,
      "printer.Branch.147",
      "auto_print",
      "orders.147",
      "147"
    );
    const exchanges = [...new Set(ch.calls.bindQueue.map((c) => c.exchange))];
    assert.deepEqual(exchanges, ["auto_print"]);
    assert.equal(
      ch.calls.bindQueue.some((c) => c.exchange === "orders.print"),
      false
    );
    assert.ok(bound.some((b) => b.includes("auto_print") && b.includes("orders.147")));
    assert.ok(bound.some((b) => b.includes("auto_print") && b.includes("branch.147")));
    assert.equal(ch.closed, false);
  });

  it("surfaces a bind error instead of swallowing it", async () => {
    const ch = mockChannel({ missingExchanges: ["auto_print"] });
    await assert.rejects(
      () =>
        bindBranchQueue(ch, "printer.Branch.147", "auto_print", "orders.147", "147"),
      (err) => {
        assert.match(String(err && err.message), /bind to auto_print failed:/);
        assert.match(String(err && err.message), /NOT_FOUND/);
        return true;
      }
    );
    assert.equal(ch.closed, true);
  });

  it("does not continue binding after the channel is closed", async () => {
    const ch = mockChannel({ missingExchanges: ["missing.ex"] });
    await assert.rejects(() =>
      bindBranchQueue(ch, "printer.Branch.147", "missing.ex", "orders.147", "147")
    );
    // First exchange in the set is the configured one; after it 404s, stop.
    const uniqueEx = [...new Set(ch.calls.bindQueue.map((c) => c.exchange))];
    assert.deepEqual(uniqueEx, ["missing.ex"]);
    assert.equal(ch.calls.bindQueue.length, 1);
  });
});

describe("live start path after queue-ready", () => {
  it("does not call bindBranchQueue on the live channel before consume", () => {
    const body = startRabbitBody(mainSrc());
    const ensure = body.indexOf("await ensureHostPrintQueue(");
    const check = body.indexOf("await liveChannel.checkQueue(liveQueueName)");
    const consume = body.indexOf("await liveChannel.consume(liveQueueName");
    assert.ok(ensure >= 0 && check > ensure && consume > check);
    assert.equal(body.includes("bindBranchQueue"), false);
    const between = body.slice(check, consume);
    assert.doesNotMatch(between, /bindBranchQueue/);
    assert.match(body, /const bound = \(await ensureHostPrintQueue\(/);
  });

  it("reaches consume when the queue is ready (no live bind)", async () => {
    const ch = mockChannel();
    const consumed = await attachLiveConsumer(ch, "printer.Branch.147");
    assert.deepEqual(ch.calls.checkQueue, ["printer.Branch.147"]);
    assert.deepEqual(ch.calls.consume, ["printer.Branch.147"]);
    assert.deepEqual(ch.calls.bindQueue, []);
    assert.equal(consumed.consumerTag, "ctag-test");
    assert.equal(ch.closed, false);
  });

  it("would not reach consume if a missing-exchange bind closed the live channel", async () => {
    const ch = mockChannel({ missingExchanges: ["orders.print"] });
    await assert.rejects(
      () => ch.bindQueue("printer.Branch.147", "orders.print", "orders.147"),
      /NOT_FOUND/
    );
    await assert.rejects(
      () => attachLiveConsumer(ch, "printer.Branch.147"),
      /Channel closed/
    );
    assert.deepEqual(ch.calls.checkQueue, ["printer.Branch.147"]);
    assert.equal(ch.calls.consume.length, 0); // checkQueue throws first
  });
});

describe("source contracts", () => {
  it("exchangesToBind source no longer adds orders.print", () => {
    const src = mainSrc();
    const start = src.indexOf("function exchangesToBind");
    const end = src.indexOf("async function bindBranchQueue", start);
    const fn = src.slice(start, end);
    assert.doesNotMatch(fn, /orders\.print/);
    assert.match(fn, /set\.add\("auto_print"\)/);
  });

  it("bindBranchQueue rethrows a wrapped bind failure (no empty catch)", () => {
    const src = mainSrc();
    const start = src.indexOf("async function bindBranchQueue");
    const end = src.indexOf("async function withTempRabbitChannel", start);
    const fn = src.slice(start, end);
    assert.match(fn, /bind to \$\{ex\} failed:/);
    assert.doesNotMatch(fn, /Exchange may not exist on this broker/);
    assert.match(fn, /throw new Error/);
  });

  it("passive / recovery path still binds without deleteQueue", () => {
    const src = mainSrc();
    const start = src.indexOf("async function ensureHostPrintQueue");
    const end = src.indexOf("async function _ensureSharedPrintQueue", start);
    const fn = src.slice(start, end);
    assert.match(fn, /Passive attach to existing queue/);
    assert.match(fn, /bindBranchQueue/);
    assert.match(fn, /Passive queue check ok but bind failed/);
    assert.doesNotMatch(fn, /deleteQueue\s*\(/);
    assert.match(fn, /The agent will NOT delete it/);
  });

  it("Consuming log still reports Bindings from ensureHostPrintQueue", () => {
    const body = startRabbitBody(mainSrc());
    assert.match(body, /Bindings: \$\{bound\.join/);
    assert.match(body, /RabbitMQ connected\./);
    assert.match(body, /Consuming \$\{liveQueueName\} as print host/);
  });
});
