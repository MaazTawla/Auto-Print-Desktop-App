/**
 * Persist secrets via Electron safeStorage when available.
 * When encryption is unavailable: keep secrets in memory for the session only,
 * never write plaintext, wipe any legacy plaintext on disk, and flag UI.
 */

"use strict";

const SECRET_KEYS = Object.freeze(["agent_token", "rabbit_password"]);

/** @type {Record<string, string>} session-only secrets when encryption unavailable */
const sessionSecrets = Object.create(null);

/** Test override: null = unavailable; object = fake safeStorage; undefined = use electron */
let _safeStorageOverride = undefined;

function setSafeStorageOverride(value) {
  _safeStorageOverride = value;
}

function clearSessionSecrets() {
  for (const key of SECRET_KEYS) delete sessionSecrets[key];
}

function getSafeStorage() {
  if (_safeStorageOverride !== undefined) return _safeStorageOverride;
  try {
    const { safeStorage } = require("electron");
    if (safeStorage && typeof safeStorage.isEncryptionAvailable === "function") {
      if (safeStorage.isEncryptionAvailable()) return safeStorage;
    }
  } catch (_) {}
  return null;
}

function isEncryptionAvailable() {
  return Boolean(getSafeStorage());
}

function encryptSecret(plain) {
  if (plain == null || plain === "") return { value: "", encrypted: false };
  const ss = getSafeStorage();
  if (!ss) return { value: "", encrypted: false, refused: true };
  try {
    const buf = ss.encryptString(String(plain));
    return {
      value: Buffer.from(buf).toString("base64"),
      encrypted: true,
    };
  } catch {
    return { value: "", encrypted: false, refused: true };
  }
}

function decryptSecret(stored, wasEncrypted) {
  if (stored == null || stored === "") return "";
  if (!wasEncrypted) return ""; // never treat disk plaintext as authoritative when reading sealed form
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
 * Migrate / load secrets.
 * - Encryption available: migrate plaintext → *_enc, wipe plaintext.
 * - Encryption unavailable: load plaintext into session memory, wipe from disk, never re-persist.
 */
function migrateAndLoadSecrets(rawCfg) {
  const cfg = rawCfg && typeof rawCfg === "object" ? { ...rawCfg } : {};
  const out = { ...cfg };
  const encryptionAvailable = isEncryptionAvailable();
  let migrated = false;
  let wipedPlaintext = false;
  const persistPatch = {};

  for (const key of SECRET_KEYS) {
    const encKey = `${key}_enc`;
    const flagKey = `${key}_is_encrypted`;

    if (encryptionAvailable && cfg[encKey] && cfg[flagKey]) {
      const plain = decryptSecret(cfg[encKey], true);
      out[key] = plain;
      if (plain) sessionSecrets[key] = plain;
      continue;
    }

    if (cfg[key] != null && String(cfg[key]) !== "") {
      const plain = String(cfg[key]);
      out[key] = plain;
      sessionSecrets[key] = plain;
      // Always wipe plaintext from disk once read
      persistPatch[key] = "";
      wipedPlaintext = true;

      if (encryptionAvailable) {
        const enc = encryptSecret(plain);
        if (enc.encrypted) {
          out[encKey] = enc.value;
          out[flagKey] = true;
          persistPatch[encKey] = enc.value;
          persistPatch[flagKey] = true;
          migrated = true;
        } else {
          // Encryption refused mid-flight — memory only
          persistPatch[encKey] = "";
          persistPatch[flagKey] = false;
        }
      } else {
        persistPatch[encKey] = "";
        persistPatch[flagKey] = false;
      }
      continue;
    }

    // Restore from session (encryption unavailable path after wipe)
    if (sessionSecrets[key]) {
      out[key] = sessionSecrets[key];
    } else {
      out[key] = out[key] || "";
    }
  }

  persistPatch.secrets_encryption_unavailable = !encryptionAvailable;
  out.secrets_encryption_unavailable = !encryptionAvailable;

  const needsPersist =
    migrated ||
    wipedPlaintext ||
    Boolean(cfg.secrets_encryption_unavailable) !== !encryptionAvailable;

  return {
    cfg: out,
    migrated,
    wipedPlaintext,
    encryptionAvailable,
    persistPatch: needsPersist ? persistPatch : null,
  };
}

function buildPersistPatch(cfg) {
  const patch = {};
  for (const key of SECRET_KEYS) {
    const encKey = `${key}_enc`;
    const flagKey = `${key}_is_encrypted`;
    if (cfg[flagKey] && cfg[encKey]) {
      patch[encKey] = cfg[encKey];
      patch[flagKey] = true;
      patch[key] = "";
    }
  }
  return patch;
}

/**
 * Prepare a config write: encrypt when possible; never write plaintext secrets.
 * Secrets stay in sessionSecrets for the process lifetime when encryption is unavailable.
 */
function sealSecretsForPersist(partial) {
  if (!partial || typeof partial !== "object") return partial;
  const out = { ...partial };
  const encryptionAvailable = isEncryptionAvailable();
  out.secrets_encryption_unavailable = !encryptionAvailable;

  for (const key of SECRET_KEYS) {
    const hasKey = Object.prototype.hasOwnProperty.call(partial, key);
    const plain = hasKey
      ? partial[key]
      : sessionSecrets[key] != null
        ? sessionSecrets[key]
        : "";

    if (hasKey) {
      if (plain == null || plain === "") {
        delete sessionSecrets[key];
        out[key] = "";
        out[`${key}_enc`] = "";
        out[`${key}_is_encrypted`] = false;
        continue;
      }
      sessionSecrets[key] = String(plain);
    }

    const sessionVal = sessionSecrets[key] || "";
    if (!sessionVal) {
      out[key] = "";
      continue;
    }

    if (encryptionAvailable) {
      const enc = encryptSecret(sessionVal);
      if (enc.encrypted) {
        out[`${key}_enc`] = enc.value;
        out[`${key}_is_encrypted`] = true;
        out[key] = "";
      } else {
        // Refuse plaintext persistence
        out[key] = "";
        out[`${key}_enc`] = "";
        out[`${key}_is_encrypted`] = false;
        out.secrets_encryption_unavailable = true;
      }
    } else {
      // Memory only — never write plaintext
      out[key] = "";
      out[`${key}_enc`] = "";
      out[`${key}_is_encrypted`] = false;
    }
  }

  return out;
}


/**
 * Single sealed writer for config.json (and any same-shape file).
 * Strips/seals agent_token and rabbit_password; never writes plaintext secrets.
 * When safeStorage is unavailable, secrets stay session-only and disk fields are empty.
 */
function writeSealedConfigFile(configPath, data) {
  const fs = require("fs");
  const path = require("path");
  if (!configPath) throw new Error("writeSealedConfigFile: configPath required");
  const sealed = sealSecretsForPersist(data && typeof data === "object" ? data : {});
  for (const key of SECRET_KEYS) {
    sealed[key] = "";
  }
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(sealed, null, 2), "utf8");
  return sealed;
}

function getSessionSecret(key) {
  return sessionSecrets[key] || "";
}

function _encryptForTest(plain, fakeSafeStorage) {
  if (!fakeSafeStorage) return encryptSecret(plain);
  const buf = fakeSafeStorage.encryptString(String(plain));
  return { value: Buffer.from(buf).toString("base64"), encrypted: true };
}

module.exports = {
  SECRET_KEYS,
  getSafeStorage,
  isEncryptionAvailable,
  encryptSecret,
  decryptSecret,
  migrateAndLoadSecrets,
  sealSecretsForPersist,
  writeSealedConfigFile,
  buildPersistPatch,
  setSafeStorageOverride,
  clearSessionSecrets,
  getSessionSecret,
  _encryptForTest,
};
