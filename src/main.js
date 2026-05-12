const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  ipcMain,
  shell,
  protocol,
  net,
  powerMonitor,
  Notification,
} = require("electron");
const checkDiskSpace = require("check-disk-space").default;
const path = require("path");
const { pathToFileURL } = require("url");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const axios = require("axios");
const amqp = require("amqplib");
const { watchWindowsPrintJob } = require("./print-job-tracker");
const { createPrintJobsStore } = require("./print-jobs-store");

/** Delays after failed attempts 1, 2, 3 before attempts 2, 3, 4 (exponential-style backoff). */
const RETRY_DELAYS_MS = [5000, 30000, 60000];
/** Total attempts: initial + 3 retries after failures. */
const MAX_ATTEMPTS = 4;

/** SumatraPDF / pdf-to-printer scaling: fit page, shrink oversized only, or original size. */
function normalizePrintScale(raw) {
  const s = String(raw ?? "").trim().toLowerCase();
  if (s === "noscale" || s === "none" || s === "original") return "noscale";
  if (s === "shrink") return "shrink";
  return "fit";
}

/** Retention in days (1–365). `fallback` used when `raw` is missing/invalid. */
function clampRetentionDays(raw, fallback) {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(365, Math.max(1, n));
}

let jobsStore = null;
const pendingRetries = new Map();
/** Warn when free space below this or below DISK_WARN_PERCENT_FREE. */
const DISK_WARN_BYTES = 500 * 1024 * 1024;
const DISK_CRITICAL_BYTES = 150 * 1024 * 1024;
const DISK_WARN_PERCENT_FREE = 5;

function getJobsStore() {
  if (!jobsStore) jobsStore = createPrintJobsStore(app.getPath("userData"));
  return jobsStore;
}

function syncJobsToState() {
  try {
    state.printJobsList = getJobsStore().readManifest();
  } catch (_) {
    state.printJobsList = [];
  }
}

function derivePdfBasename(filePath, isUrl) {
  try {
    if (isUrl) {
      const u = new URL(filePath);
      const base = path.basename(u.pathname);
      if (base && /\.pdf$/i.test(base)) return base;
    } else {
      const base = path.basename(filePath);
      if (base) return base;
    }
  } catch (_) {}
  return `order-${Date.now()}.pdf`;
}

async function saveIncomingPdf(store, jobId, filePath, isUrl) {
  await ensureSpaceForIncomingPdf();
  const rawBase = derivePdfBasename(filePath, isUrl);
  const safeBase = rawBase.replace(/[^a-zA-Z0-9._-]/g, "_") || "order.pdf";
  const dest = path.join(store.incoming, `${jobId}_${safeBase}`);
  try {
    if (isUrl) {
      const res = await axios.get(filePath, { responseType: "arraybuffer", timeout: 120000 });
      fs.writeFileSync(dest, Buffer.from(res.data));
    } else {
      const resolved = path.resolve(filePath);
      if (!fs.existsSync(resolved)) throw new Error("Local PDF not found: " + resolved);
      fs.copyFileSync(resolved, dest);
    }
  } catch (err) {
    if (isNoSpaceError(err)) {
      await emergencyDiskCleanup();
      await refreshDiskSpaceStatus({ silent: true });
      if (state.diskSpace.status === "critical") {
        throw new Error("Disk full — could not save PDF. Freed old logs/jobs; free more space and retry.");
      }
      if (isUrl) {
        const res = await axios.get(filePath, { responseType: "arraybuffer", timeout: 120000 });
        fs.writeFileSync(dest, Buffer.from(res.data));
      } else {
        const resolved = path.resolve(filePath);
        fs.copyFileSync(resolved, dest);
      }
    } else {
      throw err;
    }
  }
  return dest;
}

function isNoSpaceError(err) {
  const c = err && (err.code || err.errno);
  return c === "ENOSPC" || c === -28;
}

function clearRetryTimer(jobId) {
  const t = pendingRetries.get(jobId);
  if (t) clearTimeout(t);
  pendingRetries.delete(jobId);
}

function moveJobToDlq(jobId, errMsg) {
  clearRetryTimer(jobId);
  const store = getJobsStore();
  const job = store.findById(jobId);
  if (!job) return;
  const dlqName = `${job.id}_${job.file}`;
  const dest = store.moveFileToDlq(job.localPath, dlqName);
  store.upsert({
    ...job,
    status: "dlq",
    lastError: errMsg,
    nextRetryAt: null,
    dlqPath: dest || "",
  });
  syncJobsToState();
  pushState();
  log(`Dead letter queue: ${job.file} — ${errMsg}`, "❌");
}

function resolveDlqSourcePath(job) {
  const store = getJobsStore();
  if (job.dlqPath && fs.existsSync(job.dlqPath)) return job.dlqPath;
  const guess = path.join(store.dlq, `${job.id}_${job.file}`);
  if (fs.existsSync(guess)) return guess;
  return null;
}

function restoreDlqToIncoming(job) {
  const src = resolveDlqSourcePath(job);
  if (!src) throw new Error("DLQ file not found on disk.");
  const store = getJobsStore();
  const baseName =
    (job.localPath && path.basename(job.localPath)) || `${job.id}_${job.file}`;
  const dest = path.join(store.incoming, baseName);
  fs.copyFileSync(src, dest);
  return dest;
}

/** Queue a print again after user action (retry failed job or resend completed). */
function manualQueuePrint(jobId, mode) {
  const store = getJobsStore();
  const job = store.findById(jobId);
  if (!job) return { ok: false, error: "Job not found." };

  clearRetryTimer(jobId);
  const st = job.status || "";

  if (st === "in-queue") {
    return { ok: false, error: "Job is already queued for printing." };
  }

  if (st === "dlq") {
    try {
      const localPath = restoreDlqToIncoming(job);
      store.upsert({
        ...job,
        status: "in-queue",
        attemptNumber: 0,
        nextRetryAt: null,
        lastError: null,
        localPath,
        dlqPath: "",
      });
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  } else if (st === "completed" && mode === "resend") {
    if (!job.localPath || !fs.existsSync(job.localPath)) {
      return { ok: false, error: "PDF file is no longer available (clean-up may have removed it)." };
    }
    store.upsert({
      ...job,
      status: "in-queue",
      attemptNumber: 0,
      nextRetryAt: null,
      lastError: null,
    });
  } else if (["retry-scheduled", "printing"].includes(st)) {
    if (!job.localPath || !fs.existsSync(job.localPath)) {
      return { ok: false, error: "PDF missing on disk." };
    }
    store.upsert({
      ...job,
      status: "in-queue",
      attemptNumber: 0,
      nextRetryAt: null,
      lastError: null,
    });
  } else if (st === "failed-setup") {
    if (!job.localPath || !fs.existsSync(job.localPath)) {
      return { ok: false, error: "PDF was never saved — cannot retry." };
    }
    store.upsert({
      ...job,
      status: "in-queue",
      attemptNumber: 0,
      nextRetryAt: null,
      lastError: null,
    });
  } else if (st === "completed") {
    return { ok: false, error: "Use Resend for completed jobs." };
  } else {
    return { ok: false, error: `Cannot queue job in status "${st}".` };
  }

  syncJobsToState();
  pushState();
  setImmediate(() => runPrintAttempt(jobId));
  log(`Manual ${mode === "resend" ? "resend" : "retry"}: ${job.file}`, "🔄");
  return { ok: true };
}

function cleanupOldPrintData() {
  const store = getJobsStore();
  store.ensureDirs();
  const cutoff = Date.now() - getJobRetentionMs();
  let removedJobs = 0;
  let deletedIncoming = 0;
  let deletedDlq = 0;
  let deletedOrphanIncoming = 0;
  let deletedOrphanDlq = 0;

  const safeUnlink = (filePath) => {
    if (!filePath || !fs.existsSync(filePath)) return false;
    try {
      fs.unlinkSync(filePath);
      return true;
    } catch (_) {
      return false;
    }
  };

  const parseRowTimeMs = (row) => {
    const t1 = Date.parse(row.updatedAt || "");
    if (Number.isFinite(t1)) return t1;
    const t2 = Date.parse(row.createdAt || "");
    if (Number.isFinite(t2)) return t2;
    return null;
  };

  const pruneDirOlderThan = (dirPath) => {
    let removed = 0;
    try {
      const names = fs.readdirSync(dirPath);
      for (const name of names) {
        const filePath = path.join(dirPath, name);
        let st;
        try {
          st = fs.statSync(filePath);
        } catch (_) {
          continue;
        }
        if (!st.isFile()) continue;
        const lastTouch = Math.max(Number(st.mtimeMs) || 0, Number(st.birthtimeMs) || 0);
        if (lastTouch < cutoff && safeUnlink(filePath)) removed += 1;
      }
    } catch (_) {}
    return removed;
  };

  try {
    const rows = store.readManifest();
    const keptRows = [];
    for (const row of rows) {
      const rowTime = parseRowTimeMs(row);
      if (rowTime == null || rowTime >= cutoff) {
        keptRows.push(row);
        continue;
      }
      removedJobs += 1;
      clearRetryTimer(row.id);
      if (safeUnlink(row.localPath)) deletedIncoming += 1;

      const dlqCandidates = [];
      if (row.dlqPath) dlqCandidates.push(row.dlqPath);
      if (row.id && row.file) dlqCandidates.push(path.join(store.dlq, `${row.id}_${row.file}`));
      let dlqDeletedForRow = false;
      for (const p of dlqCandidates) {
        if (safeUnlink(p)) {
          dlqDeletedForRow = true;
          break;
        }
      }
      if (dlqDeletedForRow) deletedDlq += 1;
    }
    if (keptRows.length !== rows.length) {
      fs.writeFileSync(store.manifestPath, JSON.stringify(keptRows, null, 2), "utf8");
    }
  } catch (err) {
    log(`Print data cleanup failed: ${err.message}`, "⚠️");
    return;
  }

  deletedOrphanIncoming = pruneDirOlderThan(store.incoming);
  deletedOrphanDlq = pruneDirOlderThan(store.dlq);

  const totalIncoming = deletedIncoming + deletedOrphanIncoming;
  const totalDlq = deletedDlq + deletedOrphanDlq;
  if (removedJobs > 0 || totalIncoming > 0 || totalDlq > 0) {
    syncJobsToState();
    pushState();
    log(
      `Print data cleanup: removed ${removedJobs} job(s), ${totalIncoming} incoming file(s), ${totalDlq} dlq file(s) older than ${getEffectiveJobRetentionDays()} day(s).`,
      "🧹"
    );
  }
}

// ─── Disk space & log file retention ───────────────────────────────────────────
let diskSpaceCheckTimer = null;
let lastDiskNotifyLevel = null;
let lastDiskNotifyAt = 0;

function getDiskSpaceTargetPath() {
  const ud = app.getPath("userData");
  if (process.platform === "win32") {
    const m = /^([a-zA-Z]):/.exec(ud);
    if (m) return `${m[1]}:`;
  }
  return ud;
}

function formatBytes(n) {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** Delete rolling log files older than retention (by date in filename YYYY-MM-DD.log). */
function cleanupOldLogFiles() {
  let deleted = 0;
  const cutoff = Date.now() - getLogRetentionMs();
  try {
    if (!fs.existsSync(LOG_DIR)) return 0;
    const names = fs.readdirSync(LOG_DIR);
    for (const file of names) {
      if (!/^\d{4}-\d{2}-\d{2}\.log$/i.test(file)) continue;
      const day = file.replace(/\.log$/i, "");
      const t = Date.parse(day + "T12:00:00.000Z");
      if (!Number.isFinite(t) || t >= cutoff) continue;
      try {
        fs.unlinkSync(path.join(LOG_DIR, file));
        deleted += 1;
      } catch (_) {}
    }
  } catch (_) {}
  return deleted;
}

function maybeNotifyDiskSpace(status, detail) {
  if (status === "ok") {
    lastDiskNotifyLevel = null;
    return;
  }
  const now = Date.now();
  const worsened =
    status === "critical" && lastDiskNotifyLevel === "low";
  if (
    !worsened &&
    status === lastDiskNotifyLevel &&
    now - lastDiskNotifyAt < 30 * 60 * 1000
  ) {
    return;
  }
  if (!Notification.isSupported()) {
    lastDiskNotifyLevel = status;
    lastDiskNotifyAt = now;
    return;
  }
  const freeLabel = detail?.freeBytes != null ? formatBytes(detail.freeBytes) : "low";
  const title =
    status === "critical"
      ? "Tawla Print Agent — Disk almost full"
      : "Tawla Print Agent — Low disk space";
  const body =
    status === "critical"
      ? `Critical storage (${freeLabel} free). Old logs and completed jobs may be removed automatically. Free disk space to avoid losing orders.`
      : `Low disk space (${freeLabel} free). Consider freeing space soon.`;
  try {
    const n = new Notification({ title, body });
    n.show();
  } catch (_) {}
  lastDiskNotifyLevel = status;
  lastDiskNotifyAt = now;
}

async function refreshDiskSpaceStatus(opts = {}) {
  const silent = !!opts.silent;
  try {
    const diskPath = getDiskSpaceTargetPath();
    const info = await checkDiskSpace(diskPath);
    const free = Number(info.free) || 0;
    const size = Number(info.size) || 0;
    const pct = size > 0 ? (free / size) * 100 : 100;
    let status = "ok";
    if (free < DISK_CRITICAL_BYTES || pct < 1.5) status = "critical";
    else if (free < DISK_WARN_BYTES || pct < DISK_WARN_PERCENT_FREE) status = "low";

    state.diskSpace = {
      status,
      freeBytes: free,
      totalBytes: size,
      freePercent: Math.round(pct * 10) / 10,
      checkedAt: new Date().toISOString(),
      diskPath,
    };
    if (!silent) {
      maybeNotifyDiskSpace(status, state.diskSpace);
    }
    pushState();

    if (status === "critical" && !opts.skipEmergencyCleanup) {
      await emergencyDiskCleanup();
      await refreshDiskSpaceStatus({ silent: true, skipEmergencyCleanup: true });
    }
    return state.diskSpace;
  } catch (err) {
    state.diskSpace = {
      status: "unknown",
      freeBytes: null,
      totalBytes: null,
      freePercent: null,
      checkedAt: new Date().toISOString(),
      error: err.message || String(err),
    };
    pushState();
    return state.diskSpace;
  }
}

async function emergencyDiskCleanup() {
  const logRemoved = cleanupOldLogFiles();
  cleanupOldPrintData();
  const trimmed = emergencyTrimJobsForDisk(60);
  if (logRemoved > 0 || trimmed > 0) {
    log(
      `Emergency disk cleanup: removed ${logRemoved} log file(s), trimmed ${trimmed} job record(s).`,
      "🧹"
    );
  }
}

/** Remove oldest completed/dlq/failed/retry rows from manifest and unlink files (does not touch in-queue/printing). */
function emergencyTrimJobsForDisk(maxRemove) {
  const store = getJobsStore();
  const rows = store.readManifest();
  const removable = (st) =>
    ["completed", "dlq", "failed-setup", "retry-scheduled"].includes(st || "");

  const safeUnlink = (filePath) => {
    if (!filePath || typeof filePath !== "string") return false;
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        return true;
      }
    } catch (_) {}
    return false;
  };

  const candidates = rows
    .filter((r) => removable(r.status))
    .map((r) => ({
      r,
      t: Date.parse(r.updatedAt || "") || Date.parse(r.createdAt || "") || 0,
    }))
    .sort((a, b) => a.t - b.t);

  let removed = 0;
  const removeIds = new Set();
  for (const { r } of candidates) {
    if (removed >= maxRemove) break;
    removeIds.add(r.id);
    clearRetryTimer(r.id);
    safeUnlink(r.localPath);
    const dlqCandidates = [];
    if (r.dlqPath) dlqCandidates.push(r.dlqPath);
    if (r.id && r.file) dlqCandidates.push(path.join(store.dlq, `${r.id}_${r.file}`));
    for (const p of dlqCandidates) {
      if (safeUnlink(p)) break;
    }
    removed += 1;
  }
  if (removeIds.size === 0) return 0;
  const kept = rows.filter((row) => !removeIds.has(row.id));
  try {
    fs.writeFileSync(store.manifestPath, JSON.stringify(kept, null, 2), "utf8");
  } catch (_) {}
  syncJobsToState();
  pushState();
  return removeIds.size;
}

async function ensureSpaceForIncomingPdf() {
  await refreshDiskSpaceStatus({ silent: true, skipEmergencyCleanup: true });
  if (state.diskSpace.status === "critical") {
    await emergencyDiskCleanup();
    await refreshDiskSpaceStatus({ silent: true, skipEmergencyCleanup: true });
  }
}

function onPrintFailure(jobId, errMsg) {
  const store = getJobsStore();
  const job = store.findById(jobId);
  if (!job) return;

  const attemptJustFinished = job.attemptNumber || 0;
  if (attemptJustFinished >= MAX_ATTEMPTS) {
    moveJobToDlq(jobId, errMsg);
    return;
  }

  const delay = RETRY_DELAYS_MS[attemptJustFinished - 1];
  const when = new Date(Date.now() + delay).toISOString();
  store.upsert({
    ...job,
    status: "retry-scheduled",
    lastError: errMsg,
    nextRetryAt: when,
  });
  syncJobsToState();
  pushState();
  log(
    `Retry scheduled for ${job.file}: attempt ${attemptJustFinished}/${MAX_ATTEMPTS} failed — next try in ${Math.round(delay / 1000)}s`,
    "⚠️"
  );

  clearRetryTimer(jobId);
  const t = setTimeout(() => {
    pendingRetries.delete(jobId);
    runPrintAttempt(jobId);
  }, delay);
  pendingRetries.set(jobId, t);
}

async function runPrintAttempt(jobId) {
  const store = getJobsStore();
  const job = store.findById(jobId);
  if (!job || job.status === "completed" || job.status === "dlq") return;

  const printerName = state.defaultPrinter;
  if (!printerName) {
    store.upsert({ ...job, status: "failed-setup", lastError: "No default printer selected" });
    syncJobsToState();
    pushState();
    log(`Job ${job.file}: no default printer — cannot print.`, "❌");
    return;
  }

  if (!job.localPath || !fs.existsSync(job.localPath)) {
    onPrintFailure(jobId, "Saved PDF missing on disk");
    return;
  }

  if (process.platform !== "win32") {
    store.upsert({
      ...job,
      status: "failed-setup",
      lastError: "Printing requires Windows (pdf-to-printer).",
    });
    syncJobsToState();
    pushState();
    log(`Job ${job.file}: printing is only supported on Windows.`, "❌");
    return;
  }

  const nextAttempt = (job.attemptNumber || 0) + 1;
  store.upsert({
    ...job,
    status: "printing",
    attemptNumber: nextAttempt,
    nextRetryAt: null,
  });
  syncJobsToState();
  pushState();

  try {
    const { print } = require("pdf-to-printer");
    const printStartedAt = Date.now();
    await print(job.localPath, buildPdfToPrinterOptions(printerName));

    let outcome = "untracked";
    if (process.platform === "win32") {
      outcome = await watchWindowsPrintJob({
        printerName,
        tmpPath: job.localPath,
        printStartedAt,
        log,
      });
    } else {
      log(`Print job submitted on "${printerName}" (queue not tracked on this OS).`, "🖨️");
    }

    const success =
      process.platform !== "win32"
        ? true
        : outcome === "finished" || outcome === "untracked";

    if (success) {
      const j = store.findById(jobId);
      store.upsert({
        ...j,
        status: "completed",
        lastError: null,
        nextRetryAt: null,
      });
      clearRetryTimer(jobId);
      state.printJobs++;
      state.lastPrintJob = {
        file: j.file,
        channel: j.channel || null,
        orderId: j.orderId != null && String(j.orderId).trim() !== "" ? String(j.orderId).trim() : null,
        at: new Date().toISOString(),
      };
      log(`Print completed: ${j.file}`, "🖨️");
      syncJobsToState();
      pushState();
      return;
    }

    const reason =
      outcome === "error"
        ? "Print queue reported an error"
        : outcome === "timeout"
          ? "Print job tracking timed out"
          : "Print did not complete successfully";
    onPrintFailure(jobId, reason);
  } catch (err) {
    onPrintFailure(jobId, err.message || String(err));
  }
}

// ─── Register custom app:// protocol ──────────────────────────────────────────
protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { secure: true, standard: true, supportFetchAPI: true } },
  { scheme: "jobpdf", privileges: { secure: true, standard: true, supportFetchAPI: true, stream: true } },
]);

/** Resolve absolute path to a job PDF under print-jobs/incoming or print-jobs/dlq only. */
function resolveJobPdfAbsolutePath(jobId) {
  const id = String(jobId ?? "").trim();
  if (!/^[a-fA-F0-9]{16}$/.test(id)) return null;
  const store = getJobsStore();
  const job = store.findById(id);
  if (!job) return null;

  const incomingRoot = path.resolve(store.incoming) + path.sep;
  const dlqRoot = path.resolve(store.dlq) + path.sep;

  const tryPath = (p) => {
    if (!p || typeof p !== "string") return null;
    let abs;
    try {
      abs = path.resolve(p.trim());
    } catch (_) {
      return null;
    }
    if (!abs.toLowerCase().endsWith(".pdf")) return null;
    if (!fs.existsSync(abs)) return null;
    if (!(abs.startsWith(incomingRoot) || abs.startsWith(dlqRoot))) return null;
    return abs;
  };

  let hit = tryPath(job.localPath);
  if (hit) return hit;
  hit = tryPath(job.dlqPath);
  if (hit) return hit;
  if (job.id && job.file) {
    hit = tryPath(path.join(store.dlq, `${job.id}_${job.file}`));
    if (hit) return hit;
  }
  return null;
}

// ─── Config ───────────────────────────────────────────────────────────────────
// Config file: %APPDATA%\tawla-print-agent\config.json
// branch_id: NSIS installer or user; default_printer: chosen in app UI
// Elevated NSIS writes branch_id to ProgramData; we merge here before reading userData.
function tryApplyStagedInstallConfig(configPath) {
  if (process.platform !== "win32") return;
  const programData = process.env.ProgramData;
  if (!programData) return;
  const staged = path.join(programData, "tawla-print-agent", "install-config.json");
  if (!fs.existsSync(staged)) return;
  try {
    const stagedData = JSON.parse(fs.readFileSync(staged, "utf8"));
    const id = String(stagedData.branch_id ?? "").trim();
    let existing = {};
    try {
      existing = JSON.parse(fs.readFileSync(configPath, "utf8"));
    } catch (_) {}
    let merged = { ...existing };
    let shouldWrite = false;
    if (id) {
      merged.branch_id = id;
      shouldWrite = true;
    }
    if (typeof stagedData.launch_on_login === "boolean") merged.launch_on_login = stagedData.launch_on_login;
    if (typeof stagedData.restart_on_crash === "boolean") merged.restart_on_crash = stagedData.restart_on_crash;
    if (typeof stagedData.launch_on_login === "boolean" || typeof stagedData.restart_on_crash === "boolean") {
      shouldWrite = true;
    }
    if (!shouldWrite) {
      try { fs.unlinkSync(staged); } catch (_) {}
      return;
    }
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(merged, null, 2), "utf8");
    fs.unlinkSync(staged);
  } catch (err) {
    console.error("Failed to apply staged install config:", err.message);
  }
}

function loadConfig() {
  const configPath = path.join(app.getPath("userData"), "config.json");
  tryApplyStagedInstallConfig(configPath);
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    const cfg = JSON.parse(raw);
    const branchId = String(cfg.branch_id || "147").trim();
    const dp = cfg.default_printer != null ? String(cfg.default_printer).trim() : "";
    const launchOnLogin = cfg.launch_on_login === undefined ? true : !!cfg.launch_on_login;
    const restartOnCrash = cfg.restart_on_crash === undefined ? true : !!cfg.restart_on_crash;
    const darkMode = cfg.dark_mode === undefined ? false : !!cfg.dark_mode;
    const printScale = normalizePrintScale(cfg.print_scale);
    const printPaperSize = cfg.print_paper_size != null ? String(cfg.print_paper_size).trim() : "";
    const legacy = cfg.retention_days;
    const logRetentionDays =
      cfg.log_retention_days !== undefined
        ? clampRetentionDays(cfg.log_retention_days, 7)
        : legacy !== undefined
          ? clampRetentionDays(legacy, 7)
          : 7;
    const jobRetentionDays =
      cfg.job_retention_days !== undefined ? clampRetentionDays(cfg.job_retention_days, 7) : 7;
    return {
      branchId,
      channel: `branch.${branchId}`,
      configPath,
      defaultPrinter: dp || null,
      launchOnLogin,
      restartOnCrash,
      darkMode,
      printScale,
      printPaperSize,
      logRetentionDays,
      jobRetentionDays,
    };
  } catch (_) {
    return {
      branchId: "147",
      channel: "branch.147",
      configPath,
      defaultPrinter: null,
      launchOnLogin: true,
      restartOnCrash: true,
      darkMode: false,
      printScale: "fit",
      printPaperSize: "",
      logRetentionDays: 7,
      jobRetentionDays: 7,
    };
  }
}

function readUserConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch (_) {
    return {};
  }
}

function saveUserConfig(partial) {
  const cur = readUserConfig();
  const next = { ...cur, ...partial };
  if ("default_printer" in partial && (partial.default_printer === null || partial.default_printer === "")) {
    delete next.default_printer;
  }
  if ("print_paper_size" in partial && (partial.print_paper_size === null || String(partial.print_paper_size).trim() === "")) {
    delete next.print_paper_size;
  }
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), "utf8");
}

const RABBITMQ_ORDERS_PRINT_EXCHANGE = process.env.RABBITMQ_ORDERS_PRINT_EXCHANGE || "orders.print";

/** Optional hard-coded fallbacks in a private fork (keep empty in shared repos). */
const BUILTIN_RABBIT_DEFAULTS = {
  host: "",
  port: null,
  username: "",
  password: "",
  exchange: "",
};

function envTrim(key) {
  const v = process.env[key];
  return v != null && String(v).trim() !== "" ? String(v).trim() : "";
}

function firstNonEmptyStr(...candidates) {
  for (const c of candidates) {
    if (c == null) continue;
    const s = String(c).trim();
    if (s !== "") return s;
  }
  return "";
}

function parseRabbitPort(raw) {
  if (raw == null || String(raw).trim() === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n >= 65536) return null;
  return Math.floor(n);
}

let rabbitDefaultsFileData = undefined;

function readRabbitDefaultsFromFile() {
  if (rabbitDefaultsFileData !== undefined) return rabbitDefaultsFileData;
  const candidates = [];
  try {
    candidates.push(path.join(app.getAppPath(), "rabbit.defaults.json"));
  } catch (_) {}
  candidates.push(path.join(__dirname, "..", "rabbit.defaults.json"));
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(p, "utf8"));
      rabbitDefaultsFileData = raw && typeof raw === "object" ? raw : {};
      return rabbitDefaultsFileData;
    } catch (err) {
      console.error("Invalid rabbit.defaults.json at " + p + ": " + (err.message || String(err)));
    }
  }
  rabbitDefaultsFileData = null;
  return rabbitDefaultsFileData;
}

/**
 * Values used when config.json has no rabbit_* (or password key absent).
 * Priority per field: env RABBITMQ_DEFAULT_* → rabbit.defaults.json → BUILTIN_*.
 * Saved Settings in config.json always override.
 */
function getMergedRabbitDefaultLayer() {
  const file = readRabbitDefaultsFromFile() || {};
  const envPort = parseRabbitPort(envTrim("RABBITMQ_DEFAULT_PORT"));
  const filePort = parseRabbitPort(file.port);
  const builtinPort = parseRabbitPort(BUILTIN_RABBIT_DEFAULTS.port);
  const port = envPort ?? filePort ?? builtinPort ?? 5672;
  const exchangeRaw = firstNonEmptyStr(
    envTrim("RABBITMQ_DEFAULT_EXCHANGE"),
    file.exchange,
    BUILTIN_RABBIT_DEFAULTS.exchange != null ? String(BUILTIN_RABBIT_DEFAULTS.exchange) : ""
  );
  return {
    protocol: "amqp",
    host: firstNonEmptyStr(envTrim("RABBITMQ_DEFAULT_HOST"), file.host, BUILTIN_RABBIT_DEFAULTS.host),
    port,
    username: firstNonEmptyStr(envTrim("RABBITMQ_DEFAULT_USERNAME"), file.username, BUILTIN_RABBIT_DEFAULTS.username),
    password: firstNonEmptyStr(envTrim("RABBITMQ_DEFAULT_PASSWORD"), file.password, BUILTIN_RABBIT_DEFAULTS.password),
    exchange: exchangeRaw || RABBITMQ_ORDERS_PRINT_EXCHANGE,
  };
}

const RABBITMQ_HEARTBEAT_SECONDS = 15;

function getRabbitEffectiveHost() {
  const cfg = readUserConfig();
  if (cfg.rabbit_host != null && String(cfg.rabbit_host).trim() !== "") {
    return String(cfg.rabbit_host).trim();
  }
  return getMergedRabbitDefaultLayer().host || "";
}

function isRabbitBrokerConfigured() {
  return getRabbitEffectiveHost() !== "";
}

function buildRabbitOptions() {
  const cfg = readUserConfig();
  const layer = getMergedRabbitDefaultLayer();
  const host = getRabbitEffectiveHost();
  if (!host) {
    return {
      configured: false,
      protocol: layer.protocol,
      host: "",
      port: layer.port,
      username: "",
      password: "",
      exchange: layer.exchange,
      url: "",
    };
  }
  let port = layer.port;
  if (cfg.rabbit_port != null && String(cfg.rabbit_port).trim() !== "") {
    const n = Number(cfg.rabbit_port);
    if (Number.isFinite(n) && n > 0 && n < 65536) port = Math.floor(n);
  }
  const username =
    cfg.rabbit_username != null && String(cfg.rabbit_username).trim() !== ""
      ? String(cfg.rabbit_username).trim()
      : layer.username;
  let password = layer.password;
  if (Object.prototype.hasOwnProperty.call(cfg, "rabbit_password")) {
    password = cfg.rabbit_password == null ? "" : String(cfg.rabbit_password);
  }
  const exchange =
    cfg.rabbit_exchange != null && String(cfg.rabbit_exchange).trim() !== ""
      ? String(cfg.rabbit_exchange).trim()
      : layer.exchange;
  const encodedUser = encodeURIComponent(username);
  const encodedPass = encodeURIComponent(password);
  const url =
    `${layer.protocol}://${encodedUser}:${encodedPass}@${host}:${port}/` +
    `?heartbeat=${RABBITMQ_HEARTBEAT_SECONDS}`;
  return {
    configured: true,
    protocol: layer.protocol,
    host,
    port,
    username,
    password,
    exchange,
    url,
  };
}

const {
  branchId,
  channel: initialChannel,
  configPath: CONFIG_PATH,
  defaultPrinter: initialDefaultPrinter,
  launchOnLogin: initialLaunchOnLogin,
  restartOnCrash: initialRestartOnCrash,
  darkMode: initialDarkMode,
  printScale: initialPrintScale,
  printPaperSize: initialPrintPaperSize,
  logRetentionDays: initialLogRetentionDays,
  jobRetentionDays: initialJobRetentionDays,
} = loadConfig();

// ─── State ────────────────────────────────────────────────────────────────────
let state = {
  rabbitmq: isRabbitBrokerConfigured() ? "connecting" : "idle", // idle | connecting | connected | error
  lastOrder: null,          // { timestamp, channel, orderId? }
  lastPrintJob: null,       // { file, channel, at, orderId? }
  printers: [],             // [{ name, status, paperSizes?, deviceId? }]
  logs: [],                 // [{ time, icon, msg }]
  printJobs: 0,
  printJobsList: [],        // persisted job rows (mirrors jobs.json)
  branchId,
  channel: initialChannel,
  defaultPrinter: initialDefaultPrinter,
  launchOnLogin: initialLaunchOnLogin,
  restartOnCrash: initialRestartOnCrash,
  darkMode: initialDarkMode,
  printScale: initialPrintScale,
  printPaperSize: initialPrintPaperSize,
  logRetentionDays: initialLogRetentionDays,
  jobRetentionDays: initialJobRetentionDays,
  diskSpace: {
    status: "ok",
    freeBytes: null,
    totalBytes: null,
    freePercent: null,
    checkedAt: null,
  },
};

function getEffectiveLogRetentionDays() {
  return clampRetentionDays(state.logRetentionDays, 7);
}

function getEffectiveJobRetentionDays() {
  return clampRetentionDays(state.jobRetentionDays, 7);
}

function getLogRetentionMs() {
  return getEffectiveLogRetentionDays() * 24 * 60 * 60 * 1000;
}

function getJobRetentionMs() {
  return getEffectiveJobRetentionDays() * 24 * 60 * 60 * 1000;
}

function buildPdfToPrinterOptions(printerName, extra = {}) {
  const opts = {
    printer: printerName,
    silent: true,
    scale: state.printScale || "fit",
    ...extra,
  };
  const ps =
    Object.prototype.hasOwnProperty.call(extra, "paperSize") && extra.paperSize != null
      ? String(extra.paperSize).trim()
      : (state.printPaperSize || "").trim();
  if (ps) opts.paperSize = ps;
  else delete opts.paperSize;
  return opts;
}

// ─── Globals ──────────────────────────────────────────────────────────────────
let tray = null;
let mainWindow = null;
let rabbitConnection = null;
let rabbitChannel = null;
let rabbitConsumerTag = null;
let rabbitReconnectTimer = null;
let rabbitHealthTimer = null;
let rabbitReconnectAttempt = 0;

function resetRabbitReconnectBackoff() {
  rabbitReconnectAttempt = 0;
}
let scheduledRestartInterval = null;
let printDataCleanupInterval = null;

// ─── Logging ──────────────────────────────────────────────────────────────────
const LOG_DIR = path.join(app.getPath("userData"), "logs");
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

cleanupOldLogFiles();

function log(msg, icon = "ℹ️") {
  const time = new Date().toLocaleTimeString("en-GB");
  const entry = { time, icon, msg };
  state.logs.unshift(entry);
  if (state.logs.length > 200) state.logs = state.logs.slice(0, 200);

  const line = `${icon} [${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    const logFile = path.join(LOG_DIR, `${new Date().toISOString().split("T")[0]}.log`);
    fs.appendFileSync(logFile, line + "\n", "utf8");
  } catch (err) {
    if (isNoSpaceError(err)) {
      try {
        cleanupOldLogFiles();
        emergencyTrimJobsForDisk(40);
        fs.appendFileSync(
          path.join(LOG_DIR, `${new Date().toISOString().split("T")[0]}.log`),
          line + "\n",
          "utf8"
        );
      } catch (_) {}
    }
  }

  pushState();
}

// ─── 80mm thermal test PDF (226 pt ≈ 80 mm @ 72 dpi) ──────────────────────────
function buildThermalTestPdfBuffer() {
  const header = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
  const t = new Date().toISOString().replace("T", " ").slice(0, 19).replace(/[()\\]/g, "-");
  const streamContent =
    "BT /F1 10 Tf 12 760 Td (Tawla Print Agent - 80mm test) Tj 0 -16 Td (------------------------) Tj " +
    `0 -16 Td (${t}) Tj 0 -16 Td (If text is clipped, set scale on the printer driver.) Tj ET`;
  const objects = [];
  objects.push("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  objects.push("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n");
  objects.push(
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 226 800] /Contents 4 0 R " +
      "/Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n"
  );
  objects.push(
    `4 0 obj\n<< /Length ${Buffer.byteLength(streamContent, "latin1")} >>\nstream\n${streamContent}\nendstream\nendobj\n`
  );
  objects.push("5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n");
  let pdf = header;
  const objStarts = [];
  for (const obj of objects) {
    objStarts.push(Buffer.byteLength(pdf, "binary"));
    pdf += obj;
  }
  const xrefPos = Buffer.byteLength(pdf, "binary");
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 0; i < objects.length; i++) {
    xref += `${String(objStarts[i]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += xref;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return Buffer.from(pdf, "binary");
}

function applyStartupIntegration() {
  try {
    app.setLoginItemSettings({
      openAtLogin: !!state.launchOnLogin,
      openAsHidden: true,
      name: "Tawla Print Agent",
    });
  } catch (err) {
    console.error("setLoginItemSettings:", err.message);
  }
}

let crashGuardsInstalled = false;

function setupCrashRestartGuards() {
  if (crashGuardsInstalled) return;
  crashGuardsInstalled = true;

  const markerFile = () => path.join(app.getPath("userData"), ".crash-restart-window.json");

  function readWindow() {
    try {
      const d = JSON.parse(fs.readFileSync(markerFile(), "utf8"));
      if (typeof d.count !== "number" || typeof d.windowStart !== "number") throw new Error("bad");
      return d;
    } catch {
      return { count: 0, windowStart: Date.now() };
    }
  }

  function writeWindow(d) {
    try {
      fs.writeFileSync(markerFile(), JSON.stringify(d), "utf8");
    } catch (_) {}
  }

  function maybeRelaunch(reason, detail) {
    if (!state.restartOnCrash) return;
    const windowMs = 5 * 60 * 1000;
    let d = readWindow();
    if (Date.now() - d.windowStart > windowMs) {
      d = { count: 0, windowStart: Date.now() };
    }
    if (d.count >= 5) {
      console.error("Crash restart limit reached (5 per 5 minutes).", reason, detail);
      return;
    }
    d.count += 1;
    writeWindow(d);
    console.error(reason, detail);
    try {
      app.relaunch();
      app.exit(1);
    } catch (_) {}
  }

  process.on("uncaughtException", (err) => {
    maybeRelaunch("uncaughtException", err);
  });

  process.on("unhandledRejection", (reason) => {
    maybeRelaunch("unhandledRejection", reason);
  });

  app.on("render-process-gone", (_event, webContents, details) => {
    if (!state.restartOnCrash) return;
    if (details.reason === "clean-exit") return;
    if (mainWindow && !mainWindow.isDestroyed() && webContents === mainWindow.webContents) {
      maybeRelaunch("render-process-gone", details);
    }
  });

  app.on("child-process-gone", (_event, details) => {
    if (!state.restartOnCrash) return;
    maybeRelaunch("child-process-gone", details);
  });

  setTimeout(() => {
    writeWindow({ count: 0, windowStart: Date.now() });
  }, 60000);
}

// ─── Public state for UI (must match get-state and state-update payloads) ─────
function getPublicState() {
  const rabbitOpts = buildRabbitOptions();
  const rabbitAuthConfigured =
    rabbitOpts.configured &&
    Boolean(rabbitOpts.password && String(rabbitOpts.password).length > 0);
  return {
    ...state,
    rabbitHost: rabbitOpts.host,
    rabbitPort: rabbitOpts.port,
    rabbitUsername: rabbitOpts.username,
    rabbitExchange: rabbitOpts.exchange,
    rabbitAuthConfigured,
    appVersion: app.getVersion(),
    userDataPath: app.getPath("userData"),
    platform: process.platform,
    printJobsRoot: path.join(app.getPath("userData"), "print-jobs"),
  };
}

// ─── IPC: renderer requests ───────────────────────────────────────────────────
ipcMain.handle("get-state", () => getPublicState());
ipcMain.handle("refresh-printers", async () => {
  await pollPrinters();
  return { ok: true, printers: state.printers };
});
ipcMain.handle("open-logs-dir", () => shell.openPath(LOG_DIR));
ipcMain.handle("open-print-jobs-dir", () => shell.openPath(getJobsStore().root));
ipcMain.handle("open-job-pdf-external", async (_e, rawId) => {
  const id = String(rawId ?? "").trim();
  const abs = resolveJobPdfAbsolutePath(id);
  if (!abs) return { ok: false, error: "No PDF on disk for this job (or path is not allowed)." };
  const err = await shell.openPath(abs);
  if (err) return { ok: false, error: err };
  return { ok: true };
});
ipcMain.on("window-minimize", () => { if (mainWindow) mainWindow.minimize(); });
ipcMain.on("window-toggle-maximize", () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.on("window-close", () => { if (mainWindow) mainWindow.hide(); });
ipcMain.handle("restart-system", async () => {
  log("Manual restart requested by user.", "🔁");
  resetRabbitReconnectBackoff();
  await restartSystem();
});

ipcMain.handle("set-branch-id", async (_e, rawId) => {
  const id = String(rawId ?? "").trim();
  if (!/^\d+$/.test(id)) {
    return { ok: false, error: "Branch ID must be a positive number." };
  }
  if (id === state.branchId) {
    return { ok: true, branchId: state.branchId, channel: state.channel };
  }
  await applyBranchId(id);
  return { ok: true, branchId: state.branchId, channel: state.channel };
});

ipcMain.handle("set-default-printer", async (_e, rawName) => {
  const name = rawName == null ? "" : String(rawName).trim();
  state.defaultPrinter = name || null;
  if (name) saveUserConfig({ default_printer: name });
  else saveUserConfig({ default_printer: null });
  log(name ? `Default printer: "${name}"` : "Default printer cleared.", "🖨️");
  pushState();
  return { ok: true, defaultPrinter: state.defaultPrinter };
});

ipcMain.handle("set-startup-settings", async (_e, opts) => {
  const login = !!opts?.launchOnLogin;
  const crash = !!opts?.restartOnCrash;
  state.launchOnLogin = login;
  state.restartOnCrash = crash;
  saveUserConfig({
    launch_on_login: login,
    restart_on_crash: crash,
  });
  applyStartupIntegration();
  log(`Startup saved — open at login: ${login}, restart on crash: ${crash}`, "⚙️");
  pushState();
  return { ok: true, launchOnLogin: login, restartOnCrash: crash };
});

ipcMain.handle("set-dark-mode", async (_e, enabled) => {
  const dark = !!enabled;
  state.darkMode = dark;
  saveUserConfig({ dark_mode: dark });
  log(`Theme saved: ${dark ? "dark" : "light"} mode`, "🎨");
  pushState();
  return { ok: true, darkMode: dark };
});

ipcMain.handle("set-print-layout", async (_e, opts) => {
  const scale = normalizePrintScale(opts?.scale);
  const paperRaw = opts?.paperSize != null ? String(opts.paperSize) : "";
  const paper = paperRaw.trim();
  state.printScale = scale;
  state.printPaperSize = paper;
  const patch = { print_scale: scale };
  if (paper) patch.print_paper_size = paper;
  else patch.print_paper_size = "";
  saveUserConfig(patch);
  log(
    `Print layout saved: scale=${scale}` + (paper ? `, paperSize="${paper}"` : ", paperSize=driver default"),
    "🖨️"
  );
  pushState();
  return { ok: true, printScale: scale, printPaperSize: paper };
});

ipcMain.handle("set-retention-settings", async (_e, opts) => {
  const logParsed = Number(opts?.logDays);
  const jobParsed = Number(opts?.jobDays);
  if (!Number.isFinite(logParsed) || logParsed < 1 || logParsed > 365) {
    return { ok: false, error: "Log retention must be a whole number between 1 and 365." };
  }
  if (!Number.isFinite(jobParsed) || jobParsed < 1 || jobParsed > 365) {
    return { ok: false, error: "Job retention must be a whole number between 1 and 365." };
  }
  state.logRetentionDays = clampRetentionDays(logParsed, 7);
  state.jobRetentionDays = clampRetentionDays(jobParsed, 7);
  const cur = readUserConfig();
  const next = {
    ...cur,
    log_retention_days: state.logRetentionDays,
    job_retention_days: state.jobRetentionDays,
  };
  delete next.retention_days;
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), "utf8");
  log(
    `Retention saved: logs older than ${state.logRetentionDays} day(s), job files older than ${state.jobRetentionDays} day(s).`,
    "⚙️"
  );
  cleanupOldPrintData();
  cleanupOldLogFiles();
  syncJobsToState();
  pushState();
  return {
    ok: true,
    logRetentionDays: state.logRetentionDays,
    jobRetentionDays: state.jobRetentionDays,
  };
});

ipcMain.handle("set-rabbit-settings", async (_e, opts) => {
  const host = opts?.host != null ? String(opts.host).trim() : "";
  const portRaw = opts?.port;
  const username = opts?.username != null ? String(opts.username).trim() : "";
  const exchange = opts?.exchange != null ? String(opts.exchange).trim() : "";
  const passwordMode = opts?.passwordMode || "keep";
  const passwordNew = opts?.passwordNew != null ? String(opts.passwordNew) : "";

  if (!host) {
    return { ok: false, error: "RabbitMQ host is required." };
  }
  const port = Number(portRaw);
  if (!Number.isFinite(port) || port <= 0 || port >= 65536) {
    return { ok: false, error: "RabbitMQ port must be a number between 1 and 65535." };
  }
  if (!username) {
    return { ok: false, error: "RabbitMQ username is required." };
  }
  if (!exchange) {
    return { ok: false, error: "Exchange is required." };
  }
  if (passwordMode === "set" && !String(passwordNew).trim()) {
    return { ok: false, error: "Enter a new password, or turn off “Set new password”." };
  }

  const patch = { rabbit_host: host, rabbit_port: port, rabbit_username: username, rabbit_exchange: exchange };
  if (passwordMode === "clear") {
    patch.rabbit_password = "";
  } else if (passwordMode === "set") {
    patch.rabbit_password = passwordNew;
  }

  saveUserConfig(patch);
  log(`RabbitMQ settings saved (${host}:${port}) — reconnecting…`, "⚙️");
  resetRabbitReconnectBackoff();
  await startRabbit();
  pushState();
  return { ok: true };
});

ipcMain.handle("retry-print-job", async (_e, rawId) => {
  const id = String(rawId ?? "").trim();
  if (!id) return { ok: false, error: "Missing job id." };
  return manualQueuePrint(id, "retry");
});

ipcMain.handle("resend-print-job", async (_e, rawId) => {
  const id = String(rawId ?? "").trim();
  if (!id) return { ok: false, error: "Missing job id." };
  return manualQueuePrint(id, "resend");
});

function getBundledPreviewPdfPath() {
  const webRoot = app.isPackaged
    ? path.join(process.resourcesPath, "app")
    : path.join(__dirname, "..");
  return path.join(webRoot, "preview.pdf");
}

ipcMain.handle("get-windows-print-meta", async () => {
  if (process.platform !== "win32") {
    return { ok: true, platformDefault: null, note: "non-windows" };
  }
  try {
    const { getDefaultPrinter } = require("pdf-to-printer");
    const p = await getDefaultPrinter();
    return { ok: true, platformDefault: p };
  } catch (err) {
    return { ok: false, platformDefault: null, error: err.message || String(err) };
  }
});

ipcMain.handle("print-preview-sample", async (_e, formOpts) => {
  if (process.platform !== "win32") {
    return { ok: false, error: "Printing the sample requires Windows (pdf-to-printer)." };
  }
  const printerName = state.defaultPrinter;
  if (!printerName) {
    return { ok: false, error: "Choose a default printer in Settings (or Home) first." };
  }
  const previewPath = getBundledPreviewPdfPath();
  if (!fs.existsSync(previewPath)) {
    return { ok: false, error: "preview.pdf is missing from the app folder." };
  }
  try {
    const { print } = require("pdf-to-printer");
    const printStartedAt = Date.now();
    log(`Sample order preview PDF printing on "${printerName}"…`, "🖨️");
    const extra = {};
    if (formOpts && typeof formOpts.scale === "string" && formOpts.scale.trim() !== "") {
      extra.scale = formOpts.scale.trim();
    }
    if (
      formOpts &&
      formOpts.paperSize != null &&
      typeof formOpts.paperSize === "string" &&
      formOpts.paperSize.trim() !== ""
    ) {
      extra.paperSize = formOpts.paperSize.trim();
    }
    await print(previewPath, buildPdfToPrinterOptions(printerName, extra));
    let outcome = "untracked";
    outcome = await watchWindowsPrintJob({
      printerName,
      tmpPath: previewPath,
      printStartedAt,
      log,
    });
    if (outcome === "finished" || outcome === "untracked") {
      state.printJobs++;
      state.lastPrintJob = {
        file: "Sample order (preview.pdf)",
        channel: null,
        orderId: null,
        at: new Date().toISOString(),
      };
      pushState();
    }
    if (outcome === "error") {
      return { ok: false, error: "Windows print queue reported an error for the sample job." };
    }
    return { ok: true, outcome };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle("test-print", async () => {
  if (process.platform !== "win32") {
    return { ok: false, error: "Test print is only supported on Windows (pdf-to-printer)." };
  }
  const printerName = state.defaultPrinter;
  if (!printerName) {
    return { ok: false, error: "Choose a default printer in Settings (or Home) first." };
  }
  const tmpPath = path.join(os.tmpdir(), `tawla-80mm-test-${Date.now()}.pdf`);
  try {
    fs.writeFileSync(tmpPath, buildThermalTestPdfBuffer());
    const { print } = require("pdf-to-printer");
    const printStartedAt = Date.now();
    log(`Test print (80mm layout) starting on "${printerName}"…`, "🖨️");
    await print(tmpPath, buildPdfToPrinterOptions(printerName, { monochrome: true }));
    let outcome = "untracked";
    outcome = await watchWindowsPrintJob({
      printerName,
      tmpPath,
      printStartedAt,
      log,
    });
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch (_) {}
    if (outcome === "finished" || outcome === "untracked") {
      state.printJobs++;
      state.lastPrintJob = {
        file: "Test print (80mm)",
        channel: null,
        orderId: null,
        at: new Date().toISOString(),
      };
      pushState();
    }
    if (outcome === "error") {
      return { ok: false, error: "Windows print queue reported an error for the test job." };
    }
    return { ok: true, outcome };
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch (_) {}
    return { ok: false, error: err.message || String(err) };
  }
});

// ─── Push state to renderer ───────────────────────────────────────────────────
function pushState() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("state-update", getPublicState());
  }
  updateTrayTooltip();
}

function updateTrayTooltip() {
  if (!tray) return;
  let r = "🔴 RabbitMQ";
  if (state.rabbitmq === "connected") r = "🟢 RabbitMQ";
  else if (state.rabbitmq === "idle") r = "⚪ Broker not configured";
  const j = `${state.printJobs} jobs finished (spooler)`;
  tray.setToolTip(`Tawla Print Agent\n${r} · ${j}`);
}

// ─── Printer polling ──────────────────────────────────────────────────────────
function normalizePrinterRows(rows) {
  const out = [];
  const seen = new Set();
  for (const p of Array.isArray(rows) ? rows : []) {
    const name = p && p.name != null ? String(p.name).trim() : "";
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const deviceId =
      p.deviceId != null && String(p.deviceId).trim() !== ""
        ? String(p.deviceId).trim()
        : "";
    out.push({
      name,
      status: p.status || "Ready",
      paperSizes: Array.isArray(p.paperSizes) ? p.paperSizes : [],
      deviceId,
    });
  }
  return out;
}

async function pollPrinters() {
  let next = [];
  let electronErr = null;
  let pdfErr = null;

  // Prefer Electron's native list from the window session if available.
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      const list = await mainWindow.webContents.getPrintersAsync();
      next = normalizePrinterRows(list);
    }
  } catch (err) {
    electronErr = err;
  }

  // Fallback/merge from pdf-to-printer (paperSizes + Win32 DeviceID / port string).
  try {
    const { getPrinters } = require("pdf-to-printer");
    const list = await getPrinters();
    const fallback = normalizePrinterRows(list);
    const pdfByName = new Map(fallback.map((p) => [p.name.toLowerCase(), p]));
    if (!next.length) {
      next = fallback;
    } else {
      for (const p of next) {
        const pdf = pdfByName.get(p.name.toLowerCase());
        if (!pdf) continue;
        if (pdf.deviceId) p.deviceId = pdf.deviceId;
        if (
          pdf.paperSizes &&
          pdf.paperSizes.length &&
          (!p.paperSizes || !p.paperSizes.length)
        ) {
          p.paperSizes = pdf.paperSizes;
        }
      }
      const existing = new Set(next.map((p) => p.name.toLowerCase()));
      for (const p of fallback) {
        const key = p.name.toLowerCase();
        if (!existing.has(key)) {
          next.push(p);
          existing.add(key);
        }
      }
    }
  } catch (err) {
    pdfErr = err;
  }

  if (!next.length && (electronErr || pdfErr)) {
    const parts = [];
    if (electronErr) parts.push("electron: " + (electronErr.message || String(electronErr)));
    if (pdfErr) parts.push("pdf-to-printer: " + (pdfErr.message || String(pdfErr)));
    log("Printer poll failed: " + parts.join(" | "), "⚠️");
  } else {
    state.printers = next;
    if (state.defaultPrinter && !state.printers.some((p) => p.name === state.defaultPrinter)) {
      state.defaultPrinter = null;
      saveUserConfig({ default_printer: null });
      log("Saved default printer is no longer available and was cleared.", "🖨️");
    }
  }

  pushState();
}

// ─── RabbitMQ ─────────────────────────────────────────────────────────────────
function getRoutingForBranch(id) {
  return {
    routingKey: `branch.${id}`,
    queueName: `printer.Branch.${id}`,
  };
}

function scheduleRabbitReconnect() {
  if (app.isQuiting || rabbitReconnectTimer) return;
  if (!isRabbitBrokerConfigured()) return;
  state.rabbitmq = "error";
  pushState();
  const base = 3000;
  const cap = 120000;
  const delay = Math.min(cap, base * Math.pow(2, rabbitReconnectAttempt));
  rabbitReconnectAttempt = Math.min(rabbitReconnectAttempt + 1, 8);
  rabbitReconnectTimer = setTimeout(() => {
    rabbitReconnectTimer = null;
    startRabbit().catch((err) => log("RabbitMQ reconnect failed: " + (err.message || String(err)), "❌"));
  }, delay);
}

function ensureRabbitHealthCheck() {
  if (rabbitHealthTimer) return;
  rabbitHealthTimer = setInterval(async () => {
    const channel = rabbitChannel;
    if (!channel || state.rabbitmq !== "connected") return;
    const { queueName } = getRoutingForBranch(state.branchId);
    try {
      await channel.checkQueue(queueName);
    } catch (err) {
      if (channel !== rabbitChannel || app.isQuiting) return;
      log("RabbitMQ health check failed: " + (err.message || String(err)), "⚠️");
      scheduleRabbitReconnect();
    }
  }, 10000);
}

function clearRabbitHealthCheck() {
  if (!rabbitHealthTimer) return;
  clearInterval(rabbitHealthTimer);
  rabbitHealthTimer = null;
}

async function stopRabbit() {
  clearRabbitHealthCheck();
  if (rabbitReconnectTimer) {
    clearTimeout(rabbitReconnectTimer);
    rabbitReconnectTimer = null;
  }
  const channelToClose = rabbitChannel;
  const connectionToClose = rabbitConnection;
  rabbitChannel = null;
  rabbitConnection = null;
  if (channelToClose && rabbitConsumerTag) {
    try { await channelToClose.cancel(rabbitConsumerTag); } catch (_) {}
  }
  rabbitConsumerTag = null;
  if (channelToClose) {
    try { await channelToClose.close(); } catch (_) {}
  }
  if (connectionToClose) {
    try { await connectionToClose.close(); } catch (_) {}
  }
}

async function startRabbit() {
  await stopRabbit();
  const rabbitOpts = buildRabbitOptions();
  if (!rabbitOpts.configured) {
    state.rabbitmq = "idle";
    const { routingKey } = getRoutingForBranch(state.branchId);
    state.channel = routingKey;
    pushState();
    log("RabbitMQ broker host not configured — set connection in Settings when ready.", "ℹ️");
    return;
  }

  state.rabbitmq = "connecting";
  pushState();

  const { routingKey, queueName } = getRoutingForBranch(state.branchId);
  state.channel = routingKey;

  try {
    const connection = await amqp.connect(rabbitOpts.url);
    rabbitConnection = connection;
    connection.on("error", (err) => {
      if (connection !== rabbitConnection) return;
      log("RabbitMQ connection error: " + err.message, "❌");
      scheduleRabbitReconnect();
    });
    connection.on("close", () => {
      if (connection !== rabbitConnection || app.isQuiting) return;
      log("RabbitMQ disconnected — restarting...", "⚠️");
      scheduleRabbitReconnect();
    });

    const channel = await connection.createChannel();
    rabbitChannel = channel;
    channel.on("error", (err) => {
      if (channel !== rabbitChannel) return;
      log("RabbitMQ channel error: " + err.message, "❌");
      scheduleRabbitReconnect();
    });
    channel.on("close", () => {
      if (channel !== rabbitChannel || app.isQuiting) return;
      scheduleRabbitReconnect();
    });

    await channel.prefetch(1);
    await channel.assertExchange(rabbitOpts.exchange, "topic", { durable: true });
    await channel.assertQueue(queueName, { durable: true });
    await channel.bindQueue(queueName, rabbitOpts.exchange, routingKey);

    const consumed = await channel.consume(queueName, async (msg) => {
      if (!msg) {
        if (channel === rabbitChannel && !app.isQuiting) {
          log("RabbitMQ consumer cancelled by broker — reconnecting...", "⚠️");
          scheduleRabbitReconnect();
        }
        return;
      }
      const message = msg.content ? msg.content.toString("utf8") : "";
      const outcome = await handleMessage(routingKey, message);
      if (channel !== rabbitChannel) return;
      try {
        if (outcome === "ack") channel.ack(msg);
        else if (outcome === "reject") channel.nack(msg, false, false);
        else channel.nack(msg, false, true);
      } catch (_) {
        // Channel may close between message handling and ack/nack.
      }
    });
    rabbitConsumerTag = consumed.consumerTag;

    state.rabbitmq = "connected";
    resetRabbitReconnectBackoff();
    ensureRabbitHealthCheck();
    log("RabbitMQ connected.", "✅");
    log(`Consuming queue ${queueName} via ${rabbitOpts.exchange} (${routingKey}).`, "📡");
    pushState();
  } catch (err) {
    state.rabbitmq = "error";
    log("RabbitMQ start failed: " + err.message, "❌");
    pushState();
    scheduleRabbitReconnect();
  }
}

/** Order id from broker JSON — snake_case or camelCase. */
function extractOrderIdFromPayload(data) {
  if (!data || typeof data !== "object") return null;
  const raw =
    data.order_id ??
    data.orderId ??
    data.OrderID ??
    data.order_number ??
    data.orderNumber ??
    data.order_no ??
    data.orderNo;
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  return s === "" ? null : s;
}

/** Prefer file_path; accept camelCase aliases used by some publishers. */
function extractFilePathFromPayload(data) {
  if (!data || typeof data !== "object") return "";
  const fp =
    data.file_path ??
    data.filePath ??
    data.pdf_path ??
    data.pdfPath ??
    data.pdf_url ??
    data.pdfUrl ??
    "";
  return typeof fp === "string" ? fp.trim() : String(fp ?? "").trim();
}

async function applyBranchId(id) {
  state.branchId = id;
  state.channel = `branch.${id}`;
  saveUserConfig({ branch_id: id });
  log(`Branch ID set to ${id} — listening on ${state.channel}`, "📌");
  pushState();
  resetRabbitReconnectBackoff();
  await startRabbit();
  await pollPrinters();
}

async function handleMessage(channel, message) {
  log(`New order on ${channel}`, "📩");

  try {
    const data = JSON.parse(message);
    const orderId = extractOrderIdFromPayload(data);
    state.lastOrder = {
      timestamp: new Date().toISOString(),
      channel,
      orderId,
    };
    pushState();

    const filePath = extractFilePathFromPayload(data);
    if (!filePath) {
      log("Missing file_path in message.", "❌");
      return "reject";
    }

    const jobId = crypto.randomBytes(8).toString("hex");
    const store = getJobsStore();
    const isUrl = filePath.startsWith("http://") || filePath.startsWith("https://");

    let localPath;
    try {
      localPath = await saveIncomingPdf(store, jobId, filePath, isUrl);
    } catch (err) {
      log("Could not save PDF: " + err.message, "❌");
      store.upsert({
        id: jobId,
        file: derivePdfBasename(filePath, isUrl),
        orderId,
        status: "failed-setup",
        attemptNumber: 0,
        nextRetryAt: null,
        lastError: err.message || String(err),
        channel,
        localPath: "",
      });
      syncJobsToState();
      pushState();
      // Poison message guard: avoid infinite broker requeue loops
      // when the payload points to a missing/invalid file.
      return "reject";
    }

    const baseFile = path.basename(localPath);
    store.upsert({
      id: jobId,
      file: baseFile,
      orderId,
      status: "in-queue",
      attemptNumber: 0,
      nextRetryAt: null,
      lastError: null,
      channel,
      localPath,
    });
    syncJobsToState();
    pushState();
    log(`Saved job PDF: ${baseFile}`, "📁");

    setImmediate(() => runPrintAttempt(jobId));
    return "ack";
  } catch (err) {
    log("Order handling error: " + err.message, "❌");
    return "reject";
  }
}

// ─── System lifecycle ─────────────────────────────────────────────────────────
async function restartSystem() {
  log("Restarting system...", "♻️");
  await startRabbit();
  await pollPrinters();
}

/** Debounce resume vs unlock so we do not double-refresh when both fire close together (e.g. wake + unlock). */
const POWER_SESSION_REFRESH_DEBOUNCE_MS = 8000;
let lastPowerSessionRefreshAt = 0;
let powerSessionGuardsInstalled = false;

function setupPowerSessionGuards() {
  if (powerSessionGuardsInstalled) return;
  powerSessionGuardsInstalled = true;

  const refreshAfterIdleReturn = (reason) => {
    if (app.isQuiting) return;
    const now = Date.now();
    if (now - lastPowerSessionRefreshAt < POWER_SESSION_REFRESH_DEBOUNCE_MS) return;
    lastPowerSessionRefreshAt = now;
    log(`Session/power event (${reason}) — refreshing RabbitMQ and printers.`, "🔌");
    restartSystem().catch((err) => {
      log("Refresh after session event failed: " + (err.message || String(err)), "⚠️");
    });
  };

  powerMonitor.on("resume", () => {
    refreshAfterIdleReturn("resume from sleep/hibernate");
  });

  powerMonitor.on("unlock-screen", () => {
    refreshAfterIdleReturn("screen unlocked");
  });

  powerMonitor.on("suspend", () => {
    if (!app.isQuiting) {
      log("System suspending — broker connection may drop until resume.", "💤");
    }
  });

  powerMonitor.on("lock-screen", () => {
    if (!app.isQuiting) {
      log("Screen locked — agent keeps running; will refresh after unlock if needed.", "🔒");
    }
  });
}

// ─── Tray ─────────────────────────────────────────────────────────────────────
function createTray() {
  // Fallback: create a simple 16x16 colored icon programmatically
  const iconPath = path.join(__dirname, "..", "assets", "icon.png");
  let icon;
  if (fs.existsSync(iconPath)) {
    icon = nativeImage.createFromPath(iconPath);
  } else {
    icon = nativeImage.createEmpty();
  }

  tray = new Tray(icon);
  tray.setToolTip("Tawla Print Agent");

  const contextMenu = Menu.buildFromTemplate([
    { label: "Open Dashboard", click: () => showWindow() },
    { type: "separator" },
    { label: "Restart Agent", click: () => restartSystem() },
    { type: "separator" },
    { label: "Quit", click: () => { app.isQuiting = true; app.quit(); } },
  ]);

  tray.setContextMenu(contextMenu);
  tray.on("double-click", () => showWindow());
}

// ─── Main window ──────────────────────────────────────────────────────────────
let windowReady = false;
let showPending = false;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 640,
    minWidth: 760,
    minHeight: 520,
    title: "Tawla Print Agent",
    backgroundColor: "#0d0f14",
    webPreferences: {
      // Same folder as main.js: with asar:false packaged layout is resources/app/src/
      preload: path.join(__dirname, "preload.js"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
    icon: path.join(__dirname, "..", "assets", "icon.png"),
    show: false,
    frame: false,
    titleBarStyle: "hidden",
  });

  mainWindow.loadURL("app://./index.html");

  // Only show after the renderer has fully painted — prevents black window
  mainWindow.once("ready-to-show", () => {
    windowReady = true;
    if (showPending) {
      mainWindow.show();
      mainWindow.focus();
      showPending = false;
    }
  });

  mainWindow.on("close", (e) => {
    if (!app.isQuiting) {
      e.preventDefault();
      mainWindow.hide();
      // Reset so next open waits for ready-to-show again if window was destroyed
      windowReady = false;
    }
  });
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    windowReady = false;
    showPending = true;
    createWindow();
    return;
  }
  if (windowReady) {
    mainWindow.show();
    mainWindow.focus();
  } else {
    showPending = true;
  }
}

// ─── App ready ────────────────────────────────────────────────────────────────
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    tryApplyStagedInstallConfig(CONFIG_PATH);
    const cfg = readUserConfig();
    const nextLogin = cfg.launch_on_login === undefined ? state.launchOnLogin : !!cfg.launch_on_login;
    const nextCrash = cfg.restart_on_crash === undefined ? state.restartOnCrash : !!cfg.restart_on_crash;
    const nextDark = cfg.dark_mode === undefined ? state.darkMode : !!cfg.dark_mode;
    const nextScale = cfg.print_scale === undefined ? state.printScale : normalizePrintScale(cfg.print_scale);
    const nextPaper =
      cfg.print_paper_size === undefined
        ? state.printPaperSize
        : cfg.print_paper_size != null
          ? String(cfg.print_paper_size).trim()
          : "";
    state.launchOnLogin = nextLogin;
    state.restartOnCrash = nextCrash;
    state.darkMode = nextDark;
    state.printScale = nextScale;
    state.printPaperSize = nextPaper;
    const legacyRt = cfg.retention_days;
    state.logRetentionDays =
      cfg.log_retention_days !== undefined
        ? clampRetentionDays(cfg.log_retention_days, 7)
        : legacyRt !== undefined
          ? clampRetentionDays(legacyRt, 7)
          : state.logRetentionDays;
    state.jobRetentionDays =
      cfg.job_retention_days !== undefined
        ? clampRetentionDays(cfg.job_retention_days, 7)
        : state.jobRetentionDays;
    applyStartupIntegration();
    const nextBranch = String(cfg.branch_id ?? "").trim();
    if (nextBranch && nextBranch !== state.branchId) {
      applyBranchId(nextBranch).catch((err) => {
        log("Could not apply staged branch update: " + (err.message || String(err)), "⚠️");
      });
    } else {
      pushState();
    }
    showWindow();
  });

  app.whenReady().then(async () => {
    if (process.platform === "win32") {
      app.setAppUserModelId("com.tawla.print-agent");
    }

    syncJobsToState();
    applyStartupIntegration();
    setupCrashRestartGuards();
    setupPowerSessionGuards();

    // Serve app files via app:// protocol — avoids file:// restrictions in Electron 29
    // index.html lives next to package.json (project root / resources/app when packaged)
    const webRoot = app.isPackaged
      ? path.join(process.resourcesPath, "app")
      : path.join(__dirname, "..");

    protocol.handle("app", (request) => {
      let pathname = "";
      try {
        const u = new URL(request.url);
        pathname = u.pathname.startsWith("/") ? u.pathname.slice(1) : u.pathname;
      } catch {
        pathname = decodeURIComponent(request.url.replace(/^app:\/\/\.?\/?/, ""));
      }
      pathname = decodeURIComponent(pathname);
      const rootResolved = path.resolve(webRoot);
      const filePath = path.resolve(path.join(rootResolved, pathname));
      if (!filePath.startsWith(rootResolved + path.sep) && filePath !== rootResolved) {
        return new Response("Forbidden", { status: 403 });
      }
      return net.fetch(pathToFileURL(filePath).href);
    });

    protocol.handle("jobpdf", async (request) => {
      try {
        const u = new URL(request.url);
        const rawPath = u.pathname.startsWith("/") ? u.pathname.slice(1) : u.pathname;
        const jobId = decodeURIComponent(rawPath.split("/")[0] || "").trim();
        const abs = resolveJobPdfAbsolutePath(jobId);
        if (!abs) return new Response("Not found", { status: 404 });
        return net.fetch(pathToFileURL(abs).href);
      } catch (err) {
        return new Response(err.message || String(err), { status: 500 });
      }
    });

    createTray();
    createWindow();
    showWindow();

    log("Tawla Print Agent started.", "🚀");
    log(`Branch ID: ${state.branchId} — listening on ${state.channel}`, "📌");
    await startRabbit();
    await pollPrinters();
    // Some USB/network printers appear a moment after app start/login.
    setTimeout(() => {
      pollPrinters().catch(() => {});
    }, 6000);
    cleanupOldPrintData();
    if (printDataCleanupInterval) clearInterval(printDataCleanupInterval);
    printDataCleanupInterval = setInterval(cleanupOldPrintData, 60 * 60 * 1000);

    await refreshDiskSpaceStatus({});
    if (diskSpaceCheckTimer) clearInterval(diskSpaceCheckTimer);
    diskSpaceCheckTimer = setInterval(() => {
      cleanupOldLogFiles();
      refreshDiskSpaceStatus({}).catch(() => {});
    }, 5 * 60 * 1000);

    // Refresh printer list regularly so hot-plugged devices appear quickly.
    setInterval(() => {
      pollPrinters().catch(() => {});
    }, 10000);

    // Scheduled 1.5h restart
    scheduledRestartInterval = setInterval(() => {
      log("Scheduled 1.5h restart.", "⏳");
      restartSystem();
    }, 5400000);
  });

  app.on("window-all-closed", (e) => e.preventDefault()); // keep running in tray
  app.on("before-quit", async () => {
    pendingRetries.forEach((t) => clearTimeout(t));
    pendingRetries.clear();
    if (scheduledRestartInterval) clearInterval(scheduledRestartInterval);
    if (printDataCleanupInterval) clearInterval(printDataCleanupInterval);
    if (diskSpaceCheckTimer) clearInterval(diskSpaceCheckTimer);
    await stopRabbit();
  });
}