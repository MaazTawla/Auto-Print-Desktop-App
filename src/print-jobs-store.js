const fs = require("fs");
const path = require("path");

function ensureDirs(root, incoming, dlq) {
  [root, incoming, dlq].forEach((d) => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  });
}

function createPrintJobsStore(userDataRoot) {
  const root = path.join(userDataRoot, "print-jobs");
  const incoming = path.join(root, "incoming");
  const dlq = path.join(root, "dlq");
  const manifestPath = path.join(root, "jobs.json");

  function readManifest() {
    ensureDirs(root, incoming, dlq);
    try {
      const raw = fs.readFileSync(manifestPath, "utf8");
      const data = JSON.parse(raw);
      return Array.isArray(data) ? data : [];
    } catch {
      return [];
    }
  }

  function writeManifest(rows) {
    ensureDirs(root, incoming, dlq);
    fs.writeFileSync(manifestPath, JSON.stringify(rows, null, 2), "utf8");
  }

  function upsert(row) {
    const rows = readManifest();
    const i = rows.findIndex((r) => r.id === row.id);
    const now = new Date().toISOString();
    const merged = {
      ...row,
      updatedAt: now,
      createdAt: row.createdAt || now,
    };
    if (i >= 0) rows[i] = { ...rows[i], ...merged };
    else rows.unshift(merged);
    while (rows.length > 500) rows.pop();
    writeManifest(rows);
    return rows;
  }

  function findById(id) {
    return readManifest().find((r) => r.id === id) || null;
  }

  function moveFileToDlq(localPath, dlqBaseName) {
    ensureDirs(root, incoming, dlq);
    const dest = path.join(dlq, dlqBaseName);
    try {
      if (fs.existsSync(localPath)) {
        fs.copyFileSync(localPath, dest);
        fs.unlinkSync(localPath);
      }
      return dest;
    } catch (err) {
      return null;
    }
  }

  return {
    root,
    incoming,
    dlq,
    manifestPath,
    readManifest,
    upsert,
    findById,
    moveFileToDlq,
    ensureDirs: () => ensureDirs(root, incoming, dlq),
  };
}

module.exports = { createPrintJobsStore };
