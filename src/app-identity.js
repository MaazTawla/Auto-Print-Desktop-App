/**
 * Persist a stable app_id for this install (UUID v4).
 */

"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

function isUuidLike(s) {
  return (
    typeof s === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      s.trim()
    )
  );
}

function generateAppId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * Read or create app_id from a JSON config object / file.
 * @param {{ readConfig: () => object, writeConfig: (partial: object) => void }} store
 */
function getOrCreateAppId(store) {
  const cfg = (store && store.readConfig && store.readConfig()) || {};
  const existing = cfg.app_id != null ? String(cfg.app_id).trim() : "";
  if (isUuidLike(existing)) return existing;
  const id = generateAppId();
  if (store && store.writeConfig) {
    store.writeConfig({ app_id: id });
  }
  return id;
}

/**
 * File-backed helper for tests / simple usage.
 */
function createFileAppIdStore(configPath) {
  function readConfig() {
    try {
      return JSON.parse(fs.readFileSync(configPath, "utf8"));
    } catch {
      return {};
    }
  }
  function writeConfig(partial) {
    const cur = readConfig();
    const next = { ...cur, ...partial };
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(next, null, 2), "utf8");
  }
  return { readConfig, writeConfig };
}

module.exports = {
  isUuidLike,
  generateAppId,
  getOrCreateAppId,
  createFileAppIdStore,
};
