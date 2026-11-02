"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { heartbeatFailureRetryMs } = require("../src/printer-list-sync-policy");

describe("heartbeat failure soon-retry (L1)", () => {
  it("matches Android min(5s*n, 20s)", () => {
    assert.equal(heartbeatFailureRetryMs(1), 5000);
    assert.equal(heartbeatFailureRetryMs(2), 10000);
    assert.equal(heartbeatFailureRetryMs(3), 15000);
    assert.equal(heartbeatFailureRetryMs(4), 20000);
    assert.equal(heartbeatFailureRetryMs(10), 20000);
  });

  it("main.js schedules soon-retry via retrySoonMs on !ok (skip when null/terminal)", () => {
    const src = fs.readFileSync(path.join(__dirname, "../src/main.js"), "utf8");
    assert.match(src, /heartbeatFailureRetryMs/);
    assert.match(src, /scheduleAgentHeartbeatSoon/);
    assert.match(src, /agentHeartbeatConsecutiveFailures/);
    assert.ok(src.includes("if (!result.ok)"));
    assert.match(src, /result\.retrySoonMs/);
  });

  it("station-printing returns retrySoonMs only for retryable HB failures", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "../src/station-printing.js"),
      "utf8"
    );
    assert.match(src, /heartbeatFailureRetryMs\(consecutiveHbFailures\)/);
    assert.match(src, /httpIsRetryable/);
    assert.match(src, /consecutiveHbFailures,/);
    assert.match(src, /retrySoonMs/);
  });
});
