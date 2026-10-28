"use strict";

/**
 * M1/N3: every config write path must go through writeSealedConfigFile /
 * sealSecretsForPersist so session secrets never land in config.json when
 * safeStorage is unavailable.
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  writeSealedConfigFile,
  sealSecretsForPersist,
  setSafeStorageOverride,
  clearSessionSecrets,
  getSessionSecret,
  SECRET_KEYS,
  migrateAndLoadSecrets,
} = require("../src/secure-store");

/** Mirrors IPC / settings patches that persist user config (main.js handlers). */
function applySettingsWritePath(configPath, pathName, cur) {
  switch (pathName) {
    case "set-branch-id":
      return writeSealedConfigFile(configPath, { ...cur, branch_id: "branch-99" });
    case "set-default-printer":
      return writeSealedConfigFile(configPath, {
        ...cur,
        default_printer: "Kitchen",
      });
    case "set-startup-settings":
      return writeSealedConfigFile(configPath, {
        ...cur,
        launch_on_login: true,
        restart_on_crash: false,
      });
    case "set-dark-mode":
      return writeSealedConfigFile(configPath, { ...cur, dark_mode: true });
    case "set-print-layout":
      return writeSealedConfigFile(configPath, {
        ...cur,
        print_scale: "fit",
        print_paper_size: "A4",
      });
    case "set-retention-settings": {
      const next = {
        ...cur,
        log_retention_days: 14,
        job_retention_days: 21,
      };
      delete next.retention_days;
      return writeSealedConfigFile(configPath, next);
    }
    case "set-rabbit-settings":
      return writeSealedConfigFile(configPath, {
        ...cur,
        rabbit_host: "mq.example",
        rabbit_port: 5672,
        rabbit_username: "agent",
        rabbit_exchange: "print",
        rabbit_routing_key: "orders.{branch_id}",
        rabbit_password: getSessionSecret("rabbit_password") || "session-pw",
      });
    case "queue-precondition-hint":
      return writeSealedConfigFile(configPath, {
        ...cur,
        queue_precondition_hint: "run artisan",
      });
    case "clear-queue-precondition-hint": {
      const next = { ...cur };
      delete next.queue_precondition_hint;
      return writeSealedConfigFile(configPath, next);
    }
    case "saveUserConfig-agent-token":
      return writeSealedConfigFile(configPath, {
        ...cur,
        agent_token: "tok-from-register",
      });
    case "migrate-persist": {
      const { cfg, persistPatch } = migrateAndLoadSecrets({
        ...cur,
        agent_token: getSessionSecret("agent_token") || "legacy",
        rabbit_password: getSessionSecret("rabbit_password") || "legacy-pw",
      });
      return writeSealedConfigFile(configPath, {
        ...cur,
        ...(persistPatch || {}),
        ...cfg,
      });
    }
    case "tryApplyStagedInstallConfig":
      // Merges staged branch_id onto existing (possibly secret-bearing) config
      return writeSealedConfigFile(configPath, {
        ...cur,
        branch_id: "staged-branch",
        launch_on_login: true,
      });
    case "app-id-write":
      return writeSealedConfigFile(configPath, {
        ...cur,
        app_id: "11111111-2222-4333-8444-555555555555",
      });
    default:
      throw new Error("unknown path " + pathName);
  }
}

const ALL_WRITE_PATHS = [
  "set-branch-id",
  "set-default-printer",
  "set-startup-settings",
  "set-dark-mode",
  "set-print-layout",
  "set-retention-settings",
  "set-rabbit-settings",
  "queue-precondition-hint",
  "clear-queue-precondition-hint",
  "saveUserConfig-agent-token",
  "migrate-persist",
  "tryApplyStagedInstallConfig",
  "app-id-write",
];

function assertNoSecretsOnDisk(configPath) {
  const raw = fs.readFileSync(configPath, "utf8");
  assert.equal(raw.includes("session-token-SECRET"), false, "agent token leaked");
  assert.equal(raw.includes("session-rabbit-PW"), false, "rabbit password leaked");
  const parsed = JSON.parse(raw);
  for (const key of SECRET_KEYS) {
    assert.equal(parsed[key] || "", "", key + " must be empty on disk");
  }
}

describe("M1/N3 sealed config writes (safeStorage unavailable)", () => {
  let dir;
  let configPath;

  beforeEach(() => {
    clearSessionSecrets();
    setSafeStorageOverride(null);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sealed-cfg-"));
    configPath = path.join(dir, "config.json");
    // Seed session-only secrets as if register loaded them into memory
    sealSecretsForPersist({
      agent_token: "session-token-SECRET",
      rabbit_password: "session-rabbit-PW",
      branch_id: "1",
    });
    writeSealedConfigFile(configPath, {
      branch_id: "1",
      agent_token: "session-token-SECRET",
      rabbit_password: "session-rabbit-PW",
      retention_days: 7,
    });
    assertNoSecretsOnDisk(configPath);
  });

  afterEach(() => {
    clearSessionSecrets();
    setSafeStorageOverride(undefined);
  });

  for (const pathName of ALL_WRITE_PATHS) {
    it(`IPC/settings path "${pathName}" never writes secrets to config.json`, () => {
      const cur = JSON.parse(fs.readFileSync(configPath, "utf8"));
      // Simulate readUserConfig spreading in-memory secrets onto cur (the M1 bug)
      cur.agent_token = getSessionSecret("agent_token");
      cur.rabbit_password = getSessionSecret("rabbit_password");
      assert.equal(cur.agent_token, "session-token-SECRET");
      applySettingsWritePath(configPath, pathName, cur);
      assertNoSecretsOnDisk(configPath);
      // Secrets may rotate in session (e.g. register) but must never appear on disk
      assert.ok(getSessionSecret("agent_token"));
      assert.equal(
        fs.readFileSync(configPath, "utf8").includes(getSessionSecret("agent_token")),
        false
      );
      if (getSessionSecret("rabbit_password")) {
        assert.equal(
          fs.readFileSync(configPath, "utf8").includes(getSessionSecret("rabbit_password")),
          false
        );
      }
    });
  }

  it("writeSealedConfigFile is the only disk writer contract", () => {
    const sealed = writeSealedConfigFile(configPath, {
      agent_token: "session-token-SECRET",
      rabbit_password: "session-rabbit-PW",
      dark_mode: false,
    });
    assert.equal(sealed.agent_token, "");
    assert.equal(sealed.rabbit_password, "");
    assert.equal(sealed.secrets_encryption_unavailable, true);
    assertNoSecretsOnDisk(configPath);
  });
});
