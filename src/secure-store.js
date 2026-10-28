/**
 * Persist secrets via Electron safeStorage when available; migrate plaintext.
 * Falls back to plaintext only when safeStorage is unavailable (tests / headless).
 */

"use strict";

const SECRET_KEYS = Object.freeze(["agent_token", "rabbit_password"]);

function getSafeStorage() {
  try {
    // electron is available in the main process
    const { safeStorage } = require("electron");
    if (safeStorage && typeof safeStorage.isEncryptionAvailable === "function") {
      if (safeStorage.isEncryptionAvailable()) return safeStorage;
    }
  } catch (_) {}
  return null;
}

function encryptSecret(plain) {
  if (plain == null || plain === "") return { value: "", encrypted: false };
  const ss = getSafeStorage();
  if (!ss) return { value: String(plain), encrypted: false };
  try {
    const buf = ss.encryptString(String(plain));
    return {
      value: Buffer.from(buf).toString("base64"),
      encrypted: true,
    };
  } catch {
    return { value: String(plain), encrypted: false };
  }
}

function decryptSecret(stored, wasEncrypted) {
  if (stored == null || stored === "") return "";
  if (!wasEncrypted) return String(stored);
  const ss = getSafeStorage();
  if (!ss) return "";
  try {
    const buf = Buffer.from(String(stored), "base64");
    return ss.decryptString(buf);
  } catch {
    return "";
  }
}

/**
 * Migrate plaintext agent_token / rabbit_password into encrypted companion keys.
 * Returns { cfg, migrated } — cfg is the config to use (secrets decrypted in memory fields).
 */
function migrateAndLoadSecrets(rawCfg) {
  const cfg = rawCfg && typeof rawCfg === "object" ? { ...rawCfg } : {};
  let migrated = false;
  const out = { ...cfg };

  for (const key of SECRET_KEYS) {
    const encKey = `${key}_enc`;
    const flagKey = `${key}_is_encrypted`;
    if (cfg[encKey] && cfg[flagKey]) {
      out[key] = decryptSecret(cfg[encKey], true);
      continue;
    }
    if (cfg[key] != null && String(cfg[key]) !== "") {
      const enc = encryptSecret(cfg[key]);
      if (enc.encrypted) {
        out[encKey] = enc.value;
        out[flagKey] = true;
        out[key] = String(cfg[key]); // keep decrypted in-memory view
        migrated = true;
      } else {
        out[key] = String(cfg[key]);
      }
    }
  }
  return { cfg: out, migrated, persistPatch: migrated ? buildPersistPatch(out) : null };
}

function buildPersistPatch(cfg) {
  const patch = {};
  for (const key of SECRET_KEYS) {
    const encKey = `${key}_enc`;
    const flagKey = `${key}_is_encrypted`;
    if (cfg[flagKey] && cfg[encKey]) {
      patch[encKey] = cfg[encKey];
      patch[flagKey] = true;
      patch[key] = ""; // wipe plaintext from disk
    }
  }
  return patch;
}

/**
 * Prepare a config write: encrypt secret keys, store under *_enc, clear plaintext.
 */
function sealSecretsForPersist(partial) {
  if (!partial || typeof partial !== "object") return partial;
  const out = { ...partial };
  for (const key of SECRET_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(partial, key)) continue;
    const plain = partial[key];
    if (plain == null || plain === "") {
      out[key] = "";
      out[`${key}_enc`] = "";
      out[`${key}_is_encrypted`] = false;
      continue;
    }
    const enc = encryptSecret(plain);
    if (enc.encrypted) {
      out[`${key}_enc`] = enc.value;
      out[`${key}_is_encrypted`] = true;
      out[key] = ""; // do not write plaintext
    } else {
      out[key] = String(plain);
      out[`${key}_is_encrypted`] = false;
    }
  }
  return out;
}

/** Test helper: inject/mock by setting global — production uses electron. */
function _encryptForTest(plain, fakeSafeStorage) {
  if (!fakeSafeStorage) return encryptSecret(plain);
  const buf = fakeSafeStorage.encryptString(String(plain));
  return { value: Buffer.from(buf).toString("base64"), encrypted: true };
}

module.exports = {
  SECRET_KEYS,
  getSafeStorage,
  encryptSecret,
  decryptSecret,
  migrateAndLoadSecrets,
  sealSecretsForPersist,
  buildPersistPatch,
  _encryptForTest,
};
