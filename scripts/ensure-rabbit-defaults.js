/**
 * Ensures rabbit.defaults.json exists (from the example) so dev and electron-builder
 * always have the file on disk. The real credentials file is gitignored; copy the
 * example in CI or edit rabbit.defaults.json locally before dist.
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const target = path.join(root, "rabbit.defaults.json");
const example = path.join(root, "rabbit.defaults.example.json");

if (!fs.existsSync(target)) {
  if (!fs.existsSync(example)) {
    console.warn("ensure-rabbit-defaults: missing rabbit.defaults.example.json");
    process.exit(0);
  }
  fs.copyFileSync(example, target);
}
