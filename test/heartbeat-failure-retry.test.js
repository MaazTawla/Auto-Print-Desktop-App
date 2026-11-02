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

  it("main.js schedules soon-retry via heartbeatFailureRetryMs on !ok", () => {
    const src = fs.readFileSync(path.join(__dirname, "../src/main.js"), "utf8");
    assert.match(src, /heartbeatFailureRetryMs/);
    assert.match(src, /scheduleAgentHeartbeatSoon/);
    assert.match(src, /agentHeartbeatConsecutiveFailures/);
    assert.ok(src.includes("if (!result.ok)"));
  });

  it("station-printing returns retrySoonMs on liveness failure", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "../src/station-printing.js"),
      "utf8"
    );
    assert.match(src, /retrySoonMs:\s*heartbeatFailureRetryMs/);
    assert.match(src, /consecutiveHbFailures,/);
  });
});
