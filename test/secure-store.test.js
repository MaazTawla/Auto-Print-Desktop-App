"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  migrateAndLoadSecrets,
  sealSecretsForPersist,
  _encryptForTest,
} = require("../src/secure-store");

describe("secure-store", () => {
  it("sealSecretsForPersist keeps non-secret fields", () => {
    const sealed = sealSecretsForPersist({
      agent_token: "tok",
      rabbit_password: "pw",
      branch_id: "1",
    });
    assert.equal(sealed.branch_id, "1");
    if (sealed.agent_token_is_encrypted) {
      assert.equal(sealed.agent_token, "");
      assert.ok(sealed.agent_token_enc);
    } else {
      assert.equal(sealed.agent_token, "tok");
    }
  });

  it("fake safeStorage encrypt/decrypt round-trip", () => {
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
    const enc = _encryptForTest("secret-token", fake);
    const round = fake.decryptString(Buffer.from(enc.value, "base64"));
    assert.equal(round, "secret-token");
    assert.equal(enc.encrypted, true);
  });

  it("migrateAndLoadSecrets returns decrypted view when plaintext present", () => {
    const { cfg, migrated } = migrateAndLoadSecrets({
      agent_token: "plain",
      rabbit_password: "rpw",
    });
    assert.equal(cfg.agent_token, "plain");
    assert.equal(typeof migrated, "boolean");
  });
});
