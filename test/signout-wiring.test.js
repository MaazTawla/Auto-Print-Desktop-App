"use strict";

const { it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const r = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");

it("R16D-I6 wiring: preload → deregister-print-agent → controller.deregister; quit does not", () => {
  // Mutation B6: remove preload entry.
  assert.match(
    r("src/preload.js"),
    /deregisterPrintAgent:\s*\(\)\s*=>\s*ipcRenderer\.invoke\("deregister-print-agent"\)/
  );
  const m = r("src/main.js");
  const i = m.indexOf('ipcMain.handle("deregister-print-agent"');
  assert.ok(i > 0, "main must handle deregister-print-agent");
  // Mutation B7: handler never calling deregister.
  assert.match(m.slice(i, i + 500), /sp\.deregister\(\)/);
  assert.match(r("index.html"), /window\.api\.deregisterPrintAgent\(\)/);
  // Friendly IPC catch (R16D-I3) — no raw err.message in catch return.
  const catchSlice = m.slice(i, i + 900);
  assert.match(catchSlice, /Couldn't sign this device out, please try again/);
  // Quit must not deregister (R15D-L1).
  const q = m.indexOf('app.on("before-quit"');
  assert.ok(q > 0);
  assert.doesNotMatch(m.slice(q, q + 700), /\.deregister\s*\(/);
});
