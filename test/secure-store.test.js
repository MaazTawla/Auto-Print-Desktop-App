"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const {
  migrateAndLoadSecrets,
  sealSecretsForPersist,
  setSafeStorageOverride,
  clearSessionSecrets,
  getSessionSecret,
  isEncryptionAvailable,
  _encryptForTest,
} = require("../src/secure-store");

describe("secure-store", () => {
  beforeEach(() => {
    clearSessionSecrets();
    setSafeStorageOverride(undefined);
  });
  afterEach(() => {
    clearSessionSecrets();
    setSafeStorageOverride(undefined);
  });

  it("N3: when encryption unavailable, seal never writes plaintext secrets", () => {
    setSafeStorageOverride(null);
    assert.equal(isEncryptionAvailable(), false);
    const sealed = sealSecretsForPersist({
      agent_token: "tok",
      rabbit_password: "pw",
      branch_id: "1",
    });
    assert.equal(sealed.branch_id, "1");
    assert.equal(sealed.agent_token, "");
    assert.equal(sealed.rabbit_password, "");
    assert.equal(sealed.secrets_encryption_unavailable, true);
    assert.equal(getSessionSecret("agent_token"), "tok");
    assert.equal(getSessionSecret("rabbit_password"), "pw");
  });

  it("N3: migrate wipes legacy plaintext when encryption unavailable", () => {
    setSafeStorageOverride(null);
    const { cfg, wipedPlaintext, persistPatch, encryptionAvailable } =
      migrateAndLoadSecrets({
        agent_token: "legacy-plain",
        rabbit_password: "rpw",
        branch_id: "9",
      });
    assert.equal(encryptionAvailable, false);
    assert.equal(wipedPlaintext, true);
    assert.equal(cfg.agent_token, "legacy-plain");
    assert.equal(getSessionSecret("agent_token"), "legacy-plain");
    assert.equal(persistPatch.agent_token, "");
    assert.equal(persistPatch.rabbit_password, "");
    assert.equal(persistPatch.secrets_encryption_unavailable, true);
  });

  it("encrypts when safeStorage available", () => {
    const fake = {
      encryptString(s) {
        return Buffer.from("ENC:" + s, "utf8");
      },
      decryptString(buf) {
        return Buffer.from(buf).toString("utf8").replace(/^ENC:/, "");
      },
      isEncryptionAvailable() {
        return true;
      },
    };
    setSafeStorageOverride(fake);
    const sealed = sealSecretsForPersist({ agent_token: "secret-token", branch_id: "1" });
    assert.equal(sealed.agent_token, "");
    assert.equal(sealed.agent_token_is_encrypted, true);
    assert.ok(sealed.agent_token_enc);
    const round = fake.decryptString(Buffer.from(sealed.agent_token_enc, "base64"));
    assert.equal(round, "secret-token");
  });

  it("fake safeStorage encrypt/decrypt round-trip helper", () => {
    const fake = {
      encryptString(s) {
        return Buffer.from("ENC:" + s, "utf8");
      },
      decryptString(buf) {
        return Buffer.from(buf).toString("utf8").replace(/^ENC:/, "");
      },
    };
    const enc = _encryptForTest("secret-token", fake);
    const round = fake.decryptString(Buffer.from(enc.value, "base64"));
    assert.equal(round, "secret-token");
    assert.equal(enc.encrypted, true);
  });
});
