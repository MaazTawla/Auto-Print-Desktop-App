"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createStationPrintingController } = require("../src/station-printing");

const HOST_CONFLICT = {
  status: 409,
  data: {
    error: {
      code: "PRINT_HOST_ALREADY_CONFIGURED",
      message: "Another device is already configured as print host for this branch.",
      current_host: { device_label: "Front counter", is_online: true },
    },
  },
};

const OBSERVER_OK = {
  status: 200,
  headers: {},
  data: {
    token: "obs|SECRET-BACKUP",
    token_type: "Bearer",
    branch_id: 1,
    app_id: "tab-2",
    is_print_host: false,
    host_epoch: 1,
    heartbeat_interval_seconds: 30,
    heartbeat_ttl_seconds: 90,
    station_printing_enabled: false,
    pdf_host: "",
    rabbit_version: null,
  },
};

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

function seed(extra = {}) {
  return {
    agent_api_base: "https://tawla.io/merchant/api/v1/print-agent",
    branch_id: "1",
    pairing_code: "CODE-JOIN",
    device_label: "Backup PC",
    rabbit_host: "mq.local",
    rabbit_user: "u",
    rabbit_pass: "p",
    rabbit_version: "v7",
    ...extra,
  };
}

function ctrlWith(store, request, extra = {}) {
  const logs = [];
  const ctrl = createStationPrintingController({
    ...store,
    request,
    log: (m) => logs.push(String(m)),
    sleep: async () => {},
    random: () => 0.5,
    ...extra,
  });
  return { ctrl, logs };
}

describe("Join as backup device (observer)", () => {
  it("host conflict keeps the code and shows current_host.device_label (Front counter)", async () => {
    const store = memoryStore(seed());
    const { ctrl } = ctrlWith(store, async () => HOST_CONFLICT);
    const r = await ctrl.ensureSession({ branchId: "1" });
    assert.equal(r.ok, false);
    assert.ok(ctrl.hostConflict);
    assert.equal(ctrl.hostConflict.current_host.device_label, "Front counter");
    assert.equal(ctrl.hostConflict.current_host.is_online, true);
    assert.equal(store.get().pairing_code, "CODE-JOIN"); // not consumed
    // Auto blocked (budget slot used)
    await ctrl.ensureSession({ branchId: "1" });
  });

  it("joinAsBackupDevice sends exactly one register with role=observer and same code", async () => {
    const store = memoryStore(seed());
    const bodies = [];
    const { ctrl } = ctrlWith(store, async (req) => {
      if (String(req.url || "").includes("/register")) {
        bodies.push(req.data);
        if (bodies.length === 1) return HOST_CONFLICT;
        return OBSERVER_OK;
      }
      return { status: 200, headers: {}, data: { is_print_host: false, host_epoch: 1 } };
    });
    await ctrl.ensureSession({ branchId: "1" });
    assert.ok(ctrl.hostConflict);
    const r = await ctrl.joinAsBackupDevice({ branchId: "1" });
    assert.equal(r.ok, true);
    assert.equal(r.role, "observer");
    assert.equal(r.isPrintHost, false);
    assert.equal(
      r.message,
      "Connected as backup device. An admin can make this device the print host in Tawla Settings → Printing → Print devices."
    );
    assert.equal(bodies.length, 2);
    assert.equal(bodies[1].role, "observer");
    assert.equal(bodies[1].pairing_code, "CODE-JOIN");
    assert.equal(bodies[0].role, "print_host");
    assert.equal(ctrl.hostConflict, null);
    assert.equal(store.get().agent_token, "obs|SECRET-BACKUP");
    assert.equal(store.get().pairing_code, ""); // consumed on success
  });

  it("never auto-joins: ensureSession after host conflict does not send observer", async () => {
    const store = memoryStore(seed());
    const roles = [];
    const { ctrl } = ctrlWith(store, async (req) => {
      if (String(req.url || "").includes("/register")) {
        roles.push(req.data && req.data.role);
        return HOST_CONFLICT;
      }
      return { status: 500, data: {} };
    });
    await ctrl.ensureSession({ branchId: "1" });
    await ctrl.ensureSession({ branchId: "1" });
    await ctrl.ensureSession({ branchId: "1" });
    assert.deepEqual(roles, ["print_host"]); // one blocked attempt only
  });

  it("Join is manual: passes persisted block; throw restores block", async () => {
    const store = memoryStore(seed());
    let n = 0;
    const hashWrites = [];
    const origWrite = store.writeConfig;
    store.writeConfig = (partial) => {
      if (Object.prototype.hasOwnProperty.call(partial, "pairing_auto_register_blocked_hash")) {
        hashWrites.push(partial.pairing_auto_register_blocked_hash);
      }
      return origWrite(partial);
    };
    const { ctrl } = ctrlWith(store, async (req) => {
      if (!String(req.url || "").includes("/register")) {
        return { status: 200, headers: {}, data: {} };
      }
      n++;
      if (n === 1) return HOST_CONFLICT;
      if (n === 2) throw new Error("ECONNRESET");
      return OBSERVER_OK;
    });
    await ctrl.ensureSession({ branchId: "1" });
    const blocked = store.get().pairing_auto_register_blocked_hash;
    assert.match(blocked, /^[0-9a-f]{64}$/);
    await assert.rejects(() => ctrl.joinAsBackupDevice({ branchId: "1" }));
    // allowManualRegister cleared the hash before the attempt, throw restored it
    assert.ok(hashWrites.includes(""), "Join must clear block via allowManualRegister before attempt");
    assert.equal(store.get().pairing_auto_register_blocked_hash, blocked);
    await ctrl.ensureSession({ branchId: "1" });
    assert.equal(n, 2);
  });

  it("double click shares one in-flight observer register", async () => {
    const store = memoryStore(seed());
    let regs = 0;
    let release;
    const gate = new Promise((r) => (release = r));
    const { ctrl } = ctrlWith(store, async (req) => {
      if (!String(req.url || "").includes("/register")) {
        return { status: 200, headers: {}, data: { is_print_host: false } };
      }
      regs++;
      if (regs === 1) return HOST_CONFLICT;
      await gate;
      return OBSERVER_OK;
    });
    await ctrl.ensureSession({ branchId: "1" });
    const p1 = ctrl.joinAsBackupDevice({ branchId: "1" });
    const p2 = ctrl.joinAsBackupDevice({ branchId: "1" });
    release();
    const [a, b] = await Promise.all([p1, p2]);
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.equal(regs, 2); // 1 host conflict + 1 shared observer
  });

  it("sends Bearer when a token is stored (re-join with new code)", async () => {
    const store = memoryStore(seed({ agent_token: "old|KEEP", pairing_code: "NEW-CODE" }));
    let seenAuth = null;
    let seenRole = null;
    const { ctrl } = ctrlWith(store, async (req) => {
      seenAuth = req.headers && req.headers.Authorization;
      seenRole = req.data && req.data.role;
      return OBSERVER_OK;
    });
    const r = await ctrl.joinAsBackupDevice({ branchId: "1" });
    assert.equal(r.ok, true);
    assert.equal(seenAuth, "Bearer old|KEEP");
    assert.equal(seenRole, "observer");
    assert.equal(store.get().agent_token, "obs|SECRET-BACKUP");
  });

  it("atomic token write on observer success; rabbit_version null → no consume", async () => {
    const store = memoryStore(seed());
    const { ctrl } = ctrlWith(store, async (req) => {
      if (String(req.url || "").includes("/register")) {
        // skip conflict — direct join
        return OBSERVER_OK;
      }
      return { status: 200, headers: {}, data: {} };
    });
    const r = await ctrl.joinAsBackupDevice({ branchId: "1" });
    assert.equal(r.ok, true);
    assert.equal(r.shouldConsume, false);
    const tokenWrites = store.writes.filter((w) =>
      Object.prototype.hasOwnProperty.call(w, "agent_token")
    );
    assert.equal(tokenWrites.length, 1);
    assert.equal(tokenWrites[0].pairing_code, "");
    assert.equal(tokenWrites[0].agent_token, "obs|SECRET-BACKUP");
    // Broker wiped with rabbit_version null
    assert.ok(!store.get().rabbit_host || store.get().rabbit_host === "");
  });

  it("observer register errors go through existing handlers (AE message + block)", async () => {
    // Direct Join (no prior host-conflict wipe) so we can assert AE keeps broker creds.
    const store = memoryStore(seed({ rabbit_host: "mq.keep", agent_token: "have|TOK" }));
    const { ctrl } = ctrlWith(store, async () => ({
      status: 409,
      data: {
        error: {
          code: "PRINT_AGENT_ALREADY_REGISTERED",
          message: "This device is already paired with this branch. Ask an admin to deregister it in Settings → Printing → Print devices, then pair again.",
        },
      },
    }));
    const r = await ctrl.joinAsBackupDevice({ branchId: "1" });
    assert.equal(r.ok, false);
    assert.match(r.pairingError.message, /Print devices/);
    assert.equal(store.get().rabbit_host, "mq.keep");
    assert.equal(store.get().agent_token, "have|TOK");
    // Budget block applied; auto ensureSession must not resend as print_host.
    const beforeHash = store.get().pairing_auto_register_blocked_hash;
    assert.match(beforeHash, /^[0-9a-f]{64}$/);
    await ctrl.ensureSession({ branchId: "1" });
    assert.equal(store.get().pairing_auto_register_blocked_hash, beforeHash);
  });

  it("token never appears in logs on Join success or failure", async () => {
    const TOK = "leak|JOIN-SECRET";
    for (const resp of [OBSERVER_OK, HOST_CONFLICT]) {
      const logs = [];
      const store = memoryStore(seed({ agent_token: TOK }));
      const { ctrl } = ctrlWith(
        store,
        async () => resp,
        { log: (m) => logs.push(String(m)) }
      );
      await ctrl.joinAsBackupDevice({ branchId: "1" }).catch(() => {});
      assert.ok(!logs.join("\n").includes(TOK));
      assert.ok(!logs.join("\n").includes("SECRET-BACKUP") || resp !== OBSERVER_OK);
      if (resp === OBSERVER_OK) {
        assert.ok(!logs.join("\n").includes("obs|SECRET-BACKUP"));
      }
    }
  });

  it("UI: host-conflict banner has Join as backup primary + Retry secondary; status Backup device", () => {
    const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
    assert.match(html, /id="host-conflict-join-backup"[^>]*>Join as backup device</);
    assert.match(html, /id="host-conflict-retry"[^>]*>Retry as print host</);
    assert.match(html, /Backup device/);
    assert.match(html, /joinAsBackupDevice/);
    const main = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
    assert.match(main, /join-as-backup-device/);
    const preload = fs.readFileSync(path.join(__dirname, "..", "src", "preload.js"), "utf8");
    assert.match(preload, /joinAsBackupDevice/);
    const sp = fs.readFileSync(path.join(__dirname, "..", "src", "station-printing.js"), "utf8");
    assert.match(
      sp,
      /async function joinAsBackupDevice[\s\S]*?allowManualRegister\(\)[\s\S]*?role:\s*"observer"/
    );
    assert.match(
      sp,
      /joinAsBackupDevice[\s\S]*?hostConflict = null/
    );
  });

  it("publicHostState after Join reports not print host / backup", async () => {
    const store = memoryStore(seed());
    const { ctrl } = ctrlWith(store, async () => OBSERVER_OK);
    await ctrl.joinAsBackupDevice({ branchId: "1" });
    const st = ctrl.publicHostState();
    assert.equal(st.isPrintHost, false);
    assert.equal(st.agentTokenConfigured, true);
    assert.equal(st.hostConflict, null);
  });
});


describe("R8D: relaunch conflict, 422 block, mixed in-flight", () => {
  it("R8D-L1: after relaunch, conflict banner + Join still offered from persisted snapshot", async () => {
    const store = memoryStore(seed());
    const { ctrl } = ctrlWith(store, async () => HOST_CONFLICT);
    await ctrl.ensureSession({ branchId: "1" });
    assert.ok(ctrl.hostConflict);
    assert.equal(ctrl.hostConflict.current_host.device_label, "Front counter");
    const snap = store.get().pairing_auto_register_blocked_conflict;
    assert.ok(snap);
    assert.equal(snap.device_label, "Front counter");
    assert.equal(snap.is_online, true);
    assert.match(store.get().pairing_auto_register_blocked_hash, /^[0-9a-f]{64}$/);

    // Relaunch: new controller, same config — no register, banner restored
    const store2 = memoryStore(store.get());
    const { ctrl: ctrl2 } = ctrlWith(store2, async () => {
      throw new Error("should not register on relaunch while blocked");
    });
    const st = ctrl2.publicHostState();
    assert.ok(st.hostConflict, "hostConflict restored");
    assert.equal(st.hostConflict.current_host.device_label, "Front counter");
    assert.equal(st.hostConflict.current_host.is_online, true);
    const s = await ctrl2.ensureSession({ branchId: "1" });
    assert.equal(s.autoRetryBlocked, true);
    assert.equal(s.ok, false);
    // Join still works after allowManual
    let joined = false;
    const store3 = memoryStore(store2.get());
    const { ctrl: ctrl3 } = ctrlWith(store3, async (req) => {
      if (String(req.url || "").includes("/register")) {
        assert.equal(req.data.role, "observer");
        joined = true;
        return OBSERVER_OK;
      }
      return { status: 200, headers: {}, data: {} };
    });
    assert.ok(ctrl3.hostConflict);
    const r = await ctrl3.joinAsBackupDevice({ branchId: "1" });
    assert.equal(r.ok, true);
    assert.equal(joined, true);
    assert.equal(ctrl3.hostConflict, null);
  });

  it("R8D-L2: Join 422 blocks the code so timer does not auto print_host", async () => {
    const store = memoryStore(seed({ device_label: "x".repeat(121) }));
    let roles = [];
    const { ctrl } = ctrlWith(store, async (req) => {
      if (String(req.url || "").includes("/register")) {
        roles.push(req.data && req.data.role);
        return {
          status: 422,
          data: { error: { code: "VALIDATION_ERROR", message: "device label too long" } },
        };
      }
      return { status: 200, headers: {}, data: {} };
    });
    const r = await ctrl.joinAsBackupDevice({ branchId: "1" });
    assert.equal(r.ok, false);
    assert.equal(store.get().pairing_code, "CODE-JOIN");
    assert.match(store.get().pairing_auto_register_blocked_hash, /^[0-9a-f]{64}$/);
    await ctrl.ensureSession({ branchId: "1" });
    await ctrl.ensureSession({ branchId: "1" });
    assert.deepEqual(roles, ["observer"]); // no automatic print_host
  });

  it("R8D-I1: host Retry in flight + Join do NOT share — two requests, print_host then observer", async () => {
    const store = memoryStore(seed());
    let release;
    const gate = new Promise((r) => (release = r));
    const roles = [];
    let n = 0;
    const { ctrl } = ctrlWith(store, async (req) => {
      if (!String(req.url || "").includes("/register")) {
        return { status: 200, headers: {}, data: {} };
      }
      roles.push(req.data && req.data.role);
      n++;
      await gate;
      if (req.data && req.data.role === "observer") return OBSERVER_OK;
      return HOST_CONFLICT;
    });
    const hostP = ctrl.registerAsHost({ branchId: "1" }); // print_host
    const joinP = ctrl.joinAsBackupDevice({ branchId: "1" }); // observer
    release();
    const [hostR, joinR] = await Promise.all([hostP, joinP]);
    assert.equal(hostR.ok, false);
    assert.ok(hostR.conflict || ctrl.hostConflict === null || joinR.ok);
    assert.equal(joinR.ok, true);
    assert.deepEqual(roles, ["print_host", "observer"]);
    assert.equal(n, 2);
  });
});


describe("R9D: stale snapshot, clearLocalAuth, throw restore, stopRabbit", () => {
  it("R9D-L1: code change clears block+snapshot; relaunch shows no banner/Join", async () => {
    const store = memoryStore(seed());
    const { ctrl } = ctrlWith(store, async () => HOST_CONFLICT);
    await ctrl.ensureSession({ branchId: "1" });
    assert.ok(store.get().pairing_auto_register_blocked_conflict);
    assert.ok(ctrl.hostConflict);
    ctrl.setPairingCode("CODE-OTHER");
    assert.equal(store.get().pairing_auto_register_blocked_hash, "");
    assert.equal(store.get().pairing_auto_register_blocked_conflict, null);
    assert.equal(ctrl.publicHostState().hostConflict, null);
    // Relaunch with the new code must not resurrect the old host label
    const store2 = memoryStore({
      ...store.get(),
      // Simulate a stale leftover that somehow remained (should still be ignored
      // once hash is cleared; also verify hash-mismatch path).
      pairing_auto_register_blocked_hash: require("node:crypto")
        .createHash("sha256")
        .update("CODE-JOIN", "utf8")
        .digest("hex"),
      pairing_auto_register_blocked_conflict: {
        device_label: "Front counter",
        is_online: false,
      },
      pairing_code: "CODE-OTHER",
    });
    const { ctrl: ctrl2 } = ctrlWith(store2, async () => HOST_CONFLICT);
    assert.equal(ctrl2.publicHostState().hostConflict, null);
    assert.equal(store2.get().pairing_auto_register_blocked_hash, "");
    assert.equal(store2.get().pairing_auto_register_blocked_conflict, null);
  });

  it("R9D-L1: matching hash still restores banner after relaunch", async () => {
    const store = memoryStore(seed());
    const { ctrl } = ctrlWith(store, async () => HOST_CONFLICT);
    await ctrl.ensureSession({ branchId: "1" });
    const store2 = memoryStore(store.get());
    const { ctrl: ctrl2 } = ctrlWith(store2, async () => {
      throw new Error("should not register");
    });
    assert.ok(ctrl2.publicHostState().hostConflict);
    assert.equal(
      ctrl2.publicHostState().hostConflict.current_host.device_label,
      "Front counter"
    );
  });

  it("R9D-L2: clearLocalAuth / deregister clears block + snapshot", async () => {
    const store = memoryStore(seed());
    const { ctrl } = ctrlWith(store, async () => HOST_CONFLICT);
    await ctrl.ensureSession({ branchId: "1" });
    assert.ok(store.get().pairing_auto_register_blocked_conflict);
    ctrl.clearLocalAuth("deregister");
    assert.equal(store.get().pairing_auto_register_blocked_hash, "");
    assert.equal(store.get().pairing_auto_register_blocked_conflict, null);
    const store2 = memoryStore(store.get());
    const { ctrl: ctrl2 } = ctrlWith(store2, async () => HOST_CONFLICT);
    assert.equal(ctrl2.publicHostState().hostConflict, null);
  });

  it("R9D-L3(c): Retry clearHostConflict + network throw restores snapshot for relaunch", async () => {
    let n = 0;
    const store = memoryStore(seed());
    const { ctrl } = ctrlWith(store, async () => {
      n += 1;
      if (n === 1) return HOST_CONFLICT;
      throw new Error("ECONNRESET");
    });
    await ctrl.ensureSession({ branchId: "1" });
    // main.js Retry path: clearHostConflict then allowManualRegister
    ctrl.clearHostConflict();
    ctrl.allowManualRegister();
    assert.equal(ctrl.publicHostState().hostConflict, null);
    await assert.rejects(() => ctrl.registerAsHost({ branchId: "1" }), /ECONNRESET/);
    // Banner restored in-session
    assert.ok(ctrl.publicHostState().hostConflict);
    assert.equal(
      ctrl.publicHostState().hostConflict.current_host.device_label,
      "Front counter"
    );
    assert.ok(store.get().pairing_auto_register_blocked_conflict);
    assert.equal(
      store.get().pairing_auto_register_blocked_conflict.device_label,
      "Front counter"
    );
    // And after relaunch
    const store2 = memoryStore(store.get());
    const { ctrl: ctrl2 } = ctrlWith(store2, async () => {
      throw new Error("blocked");
    });
    assert.ok(ctrl2.publicHostState().hostConflict);
    assert.equal(
      ctrl2.publicHostState().hostConflict.current_host.device_label,
      "Front counter"
    );
  });

  it("R9D-L3(c): Join network throw restores snapshot for relaunch", async () => {
    let n = 0;
    const store = memoryStore(seed());
    const { ctrl } = ctrlWith(store, async () => {
      n += 1;
      if (n === 1) return HOST_CONFLICT;
      throw new Error("ENETUNREACH");
    });
    await ctrl.ensureSession({ branchId: "1" });
    await assert.rejects(() => ctrl.joinAsBackupDevice({ branchId: "1" }), /ENETUNREACH/);
    assert.ok(store.get().pairing_auto_register_blocked_conflict);
    assert.ok(ctrl.publicHostState().hostConflict);
    const store2 = memoryStore(store.get());
    const { ctrl: ctrl2 } = ctrlWith(store2, async () => {
      throw new Error("blocked");
    });
    assert.ok(ctrl2.publicHostState().hostConflict);
  });

  it("R9D-I1: snapshot label must be a string ≤120; else Another device", () => {
    const crypto = require("node:crypto");
    const hash = crypto.createHash("sha256").update("CODE-JOIN", "utf8").digest("hex");
    const ui = require("../src/pairing-ui-policy");
    for (const [label, expectLabel] of [
      [{ device_label: { x: 1 }, is_online: true }, ""], // non-string → empty → UI says Another device
      [{ device_label: 42, is_online: true }, ""],
      [{ device_label: "A".repeat(200), is_online: false }, "A".repeat(120)],
      [{ device_label: "OK-Host", is_online: true }, "OK-Host"],
    ]) {
      const store = memoryStore(
        seed({
          pairing_auto_register_blocked_hash: hash,
          pairing_auto_register_blocked_conflict: label,
        })
      );
      const { ctrl } = ctrlWith(store, async () => HOST_CONFLICT);
      const hc = ctrl.publicHostState().hostConflict;
      assert.ok(hc);
      assert.equal(hc.current_host.device_label, expectLabel);
      const meta = ui.hostConflictMeta(hc.current_host);
      if (!expectLabel) {
        assert.match(meta, /Another device/);
      } else if (expectLabel.length === 120) {
        assert.equal(hc.current_host.device_label.length, 120);
        assert.ok(!meta.includes("A".repeat(121)));
      } else {
        assert.match(meta, /OK-Host/);
      }
    }
  });

  it("R9D-L3(a): main.js heartbeat authError path awaits stopRabbit", () => {
    const main = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
    // Pin the demoted-host / token-reject path: authError|needsPairing → await stopRabbit().
    assert.match(
      main,
      /if\s*\(\s*result\.authError\s*\|\|\s*result\.needsPairing\s*\)\s*\{[\s\S]*?await\s+stopRabbit\s*\(\s*\)\s*;/
    );
    // Must not be only on the revoked branch.
    const authIdx = main.search(/result\.authError\s*\|\|\s*result\.needsPairing/);
    const revokedIdx = main.search(/if\s*\(\s*result\.revoked\s*\)/);
    assert.ok(authIdx > 0 && revokedIdx > authIdx);
    const authBlock = main.slice(authIdx, revokedIdx);
    assert.match(authBlock, /await\s+stopRabbit\s*\(\s*\)/);
  });
});


describe("R10D: upper-case hash, code-point label cap, live 409 cap", () => {
  const crypto = require("node:crypto");
  const { parseHostConflictError, capHostDeviceLabel } = require("../src/agent-contract");
  const asciiUpper = (c) =>
    String(c).trim().replace(/[a-z]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 32));
  const hashUpper = (c) =>
    crypto.createHash("sha256").update(asciiUpper(c), "utf8").digest("hex");
  const hashLegacy = (c) =>
    crypto.createHash("sha256").update(String(c).trim(), "utf8").digest("hex");

  it("R10D-L1: lower-case retype of blocked code keeps the block (no auto-resend)", async () => {
    const store = memoryStore(seed({ pairing_code: "ABC123" }));
    let calls = 0;
    const { ctrl } = ctrlWith(store, async () => {
      calls++;
      return HOST_CONFLICT;
    });
    await ctrl.ensureSession({});
    assert.equal(calls, 1);
    assert.equal(store.get().pairing_auto_register_blocked_hash, hashUpper("ABC123"));
    ctrl.setPairingCode("abc123"); // case-only retype
    assert.equal(store.get().pairing_auto_register_blocked_hash, hashUpper("ABC123"));
    assert.ok(ctrl.publicHostState().hostConflict);
    await ctrl.ensureSession({});
    assert.equal(calls, 1, "must not auto-resend after case-only retype");
  });

  it("R10D-L1: legacy case-sensitive hash still matches and migrates without dropping block", async () => {
    const legacy = hashLegacy("abc123"); // pre-R10D stored form
    assert.notEqual(legacy, hashUpper("abc123"));
    const store = memoryStore(
      seed({
        pairing_code: "abc123",
        pairing_auto_register_blocked_hash: legacy,
        pairing_auto_register_blocked_conflict: {
          device_label: "Kitchen PC",
          is_online: false,
        },
      })
    );
    let calls = 0;
    const { ctrl } = ctrlWith(store, async () => {
      calls++;
      return HOST_CONFLICT;
    });
    const hc = ctrl.publicHostState().hostConflict;
    assert.ok(hc, "legacy hash must still restore banner");
    assert.equal(hc.current_host.device_label, "Kitchen PC");
    assert.equal(store.get().pairing_auto_register_blocked_hash, hashUpper("abc123"));
    assert.equal(store.get().pairing_auto_register_blocked_conflict.device_label, "Kitchen PC");
    await ctrl.ensureSession({});
    assert.equal(calls, 0, "must stay blocked after migration");
  });

  it("R10D-I1: emoji label capped at 120 code points without splitting a surrogate", () => {
    const emoji = "😀";
    const raw = "a" + emoji.repeat(70); // 71 code points; UTF-16 length > 120
    assert.equal(Array.from(raw).length, 71);
    assert.ok(raw.length > 120);
    assert.equal(Array.from(capHostDeviceLabel(raw)).length, 71);
    const cappedHuge = capHostDeviceLabel(emoji.repeat(200));
    assert.equal(Array.from(cappedHuge).length, 120);
    assert.equal(cappedHuge, emoji.repeat(120));
    const hash = hashUpper("CODE-JOIN");
    const store = memoryStore(
      seed({
        pairing_auto_register_blocked_hash: hash,
        pairing_auto_register_blocked_conflict: {
          device_label: emoji.repeat(200),
          is_online: true,
        },
      })
    );
    const { ctrl } = ctrlWith(store, async () => HOST_CONFLICT);
    const label = ctrl.publicHostState().hostConflict.current_host.device_label;
    assert.equal(Array.from(label).length, 120);
    assert.equal(label, emoji.repeat(120));
  });

  it("R10D-I2: live 409 current_host.device_label gets the same string-only 120 code-point cap", () => {
    const emoji = "😀";
    const h = parseHostConflictError(
      {
        error: {
          code: "PRINT_HOST_ALREADY_CONFIGURED",
          message: "taken",
          current_host: { device_label: emoji.repeat(200), is_online: true },
        },
      },
      409
    );
    assert.equal(Array.from(h.current_host.device_label).length, 120);
    assert.equal(h.current_host.device_label, emoji.repeat(120));
    const nonString = parseHostConflictError(
      {
        error: {
          code: "PRINT_HOST_ALREADY_CONFIGURED",
          current_host: { device_label: { x: 1 }, is_online: false },
        },
      },
      409
    );
    assert.equal(nonString.current_host.device_label, "");
    const longAscii = parseHostConflictError(
      {
        error: {
          code: "PRINT_HOST_ALREADY_CONFIGURED",
          current_host: { device_label: "B".repeat(200), is_online: true },
        },
      },
      409
    );
    assert.equal(longAscii.current_host.device_label, "B".repeat(120));
  });
});


describe("R11D: legacy case forms, ASCII upper, grapheme cap", () => {
  const crypto = require("node:crypto");
  const { parseHostConflictError, capHostDeviceLabel } = require("../src/agent-contract");
  const asciiUpper = (c) =>
    String(c).trim().replace(/[a-z]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 32));
  const hashUpper = (c) =>
    crypto.createHash("sha256").update(asciiUpper(c), "utf8").digest("hex");
  const hashLegacy = (c) =>
    crypto.createHash("sha256").update(String(c).trim(), "utf8").digest("hex");

  it("R11D-L1: legacy hash of lower-case code still blocks after upper-case retype/relaunch", async () => {
    const legacy = hashLegacy("abc123");
    assert.notEqual(legacy, hashUpper("ABC123"));
    assert.notEqual(legacy, hashLegacy("ABC123"));
    const store = memoryStore(
      seed({
        pairing_code: "ABC123",
        pairing_auto_register_blocked_hash: legacy,
        pairing_auto_register_blocked_conflict: {
          device_label: "Kitchen PC",
          is_online: true,
        },
      })
    );
    let calls = 0;
    const { ctrl } = ctrlWith(store, async () => {
      calls++;
      return HOST_CONFLICT;
    });
    assert.ok(ctrl.publicHostState().hostConflict, "must restore banner across case change");
    assert.equal(store.get().pairing_auto_register_blocked_hash, hashUpper("ABC123"));
    await ctrl.ensureSession({});
    assert.equal(calls, 0, "must never resend after legacy+case retype");
  });

  it("R11D-I1: ASCII-only upper — ß/ı/é do not over-block against SS/I/É", async () => {
    assert.equal(asciiUpper("straße"), "STRAßE");
    assert.notEqual(asciiUpper("straße"), "STRASSE");
    assert.equal(asciiUpper("café"), "CAFé");
    const store = memoryStore(seed({ pairing_code: "straße" }));
    let calls = 0;
    const { ctrl } = ctrlWith(store, async () => {
      calls++;
      return HOST_CONFLICT;
    });
    await ctrl.ensureSession({});
    assert.equal(calls, 1);
    assert.equal(store.get().pairing_auto_register_blocked_hash, hashUpper("straße"));
    ctrl.setPairingCode("STRASSE");
    assert.equal(store.get().pairing_auto_register_blocked_hash, "");
    assert.equal(ctrl.publicHostState().hostConflict, null);
    await ctrl.ensureSession({});
    assert.equal(calls, 2, "STRASSE is a different code under ASCII upper");
  });

  it("R11D-I2: cap at 120 graphemes under dual code-point limit", () => {
    const family = "👨‍👩‍👧‍👦";
    assert.ok(Array.from(family).length > 1, "family emoji is multiple code points");
    const capped = capHostDeviceLabel(family.repeat(200));
    assert.ok(typeof Intl !== "undefined" && typeof Intl.Segmenter === "function");
    const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    assert.ok([...seg.segment(capped)].length <= 120);
    assert.ok(Array.from(capped).length <= 120);
    assert.equal(capped, family.repeat(Math.floor(120 / Array.from(family).length)));
    const live = parseHostConflictError(
      {
        error: {
          code: "PRINT_HOST_ALREADY_CONFIGURED",
          current_host: { device_label: family.repeat(200), is_online: true },
        },
      },
      409
    );
    assert.equal(live.current_host.device_label, capped);
  });
});


describe("R12D: ASCII legacy variants, dual cap, survivor guards", () => {
  const crypto = require("node:crypto");
  const { capHostDeviceLabel } = require("../src/agent-contract");
  const asciiUpper = (c) =>
    String(c).trim().replace(/[a-z]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 32));
  const hashUpper = (c) =>
    crypto.createHash("sha256").update(asciiUpper(c), "utf8").digest("hex");
  const hashLegacy = (c) =>
    crypto.createHash("sha256").update(String(c).trim(), "utf8").digest("hex");

  it("R12D-L1: é/É stay distinct; b3c770a STRASSE hash does not block straße; no flip", async () => {
    // Current-format hash of "é" must not match typed "É"
    const store = memoryStore(
      seed({
        pairing_code: "É",
        pairing_auto_register_blocked_hash: hashUpper("é"),
        pairing_auto_register_blocked_conflict: { device_label: "X", is_online: false },
      })
    );
    let calls = 0;
    const { ctrl } = ctrlWith(store, async () => {
      calls++;
      return HOST_CONFLICT;
    });
    assert.equal(ctrl.publicHostState().hostConflict, null);
    await ctrl.ensureSession({});
    assert.equal(calls, 1);
    // Retype opposite accent must not flip the stored hash back and forth
    const after = store.get().pairing_auto_register_blocked_hash;
    assert.equal(after, hashUpper("É"));
    ctrl.setPairingCode("é");
    assert.equal(store.get().pairing_auto_register_blocked_hash, "");

    // b3c770a unicode-upper STRASSE must not block straße
    const store2 = memoryStore(
      seed({
        pairing_code: "straße",
        pairing_auto_register_blocked_hash: hashLegacy("STRASSE"),
        pairing_auto_register_blocked_conflict: { device_label: "Y", is_online: true },
      })
    );
    let calls2 = 0;
    const { ctrl: ctrl2 } = ctrlWith(store2, async () => {
      calls2++;
      return HOST_CONFLICT;
    });
    await ctrl2.ensureSession({});
    assert.equal(calls2, 1, "STRASSE legacy must not block straße");
  });

  it("R12D-L2: mixed-case legacy AbC123 matches abc123 via ASCII enumeration", async () => {
    const legacy = hashLegacy("AbC123");
    const store = memoryStore(
      seed({
        pairing_code: "abc123",
        pairing_auto_register_blocked_hash: legacy,
        pairing_auto_register_blocked_conflict: { device_label: "Z", is_online: false },
      })
    );
    let calls = 0;
    const { ctrl } = ctrlWith(store, async () => {
      calls++;
      return HOST_CONFLICT;
    });
    assert.ok(ctrl.publicHostState().hostConflict);
    assert.equal(store.get().pairing_auto_register_blocked_hash, hashUpper("abc123"));
    await ctrl.ensureSession({});
    assert.equal(calls, 0);
  });

  it("R12D-I3 FE survivors: cap121, Segmenter throw, UTF-16 fallback", () => {
    assert.equal(capHostDeviceLabel("A".repeat(121)).length, 120);
    const S = Intl.Segmenter;
    try {
      Intl.Segmenter = function () {
        throw new Error("x");
      };
      assert.equal(Array.from(capHostDeviceLabel("😀".repeat(200))).length, 120);
    } finally {
      Intl.Segmenter = S;
    }
    try {
      Intl.Segmenter = undefined;
      const huge = "😀".repeat(200);
      const capped = capHostDeviceLabel(huge);
      assert.equal(Array.from(capped).length, 120);
      assert.notEqual(capped, huge.slice(0, 120));
    } finally {
      Intl.Segmenter = S;
    }
  });
});
