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
const { createStationPrintingController } = require("./station-printing");
const discoveredPrinter = require("./discovered-printer");
const { scanLanPrinters } = require("./lan-printer-scanner");
const lanHostValidation = require("./lan-host-validation");
const {
  syncBranchIdFromServer,
  shouldReconnectAfterBranchApply,
  shouldFlushPendingBranchReconnect,
} = require("./rabbit-branch-sync");
const { ASSUMPTIONS: STATION_PRINT_ASSUMPTIONS, verifyPdfChecksum, classifyPdfUrlHttpStatus, ERROR_CODES: STATION_ERROR_CODES } = require("./agent-contract");
const {
  buildPdfAxiosConfig,
  isPdfTooLargeError,
  DEFAULT_MAX_PDF_BYTES,
  BASE64_MAX_PDF_BYTES,
  normalizePdfBase64Input,
  assertBase64WithinDecodedMax,
} = require("./pdf-fetch-policy");
const { heartbeatFailureRetryMs } = require("./printer-list-sync-policy");
const {
  migrateAndLoadSecrets,
  writeSealedConfigFile,
  SECRET_KEYS,
  isEncryptionAvailable,
  getSessionSecret,
} = require("./secure-store");
const { createProcessedJobsStore } = require("./processed-jobs");
const { createAckOutbox, shouldLogRetryFailure } = require("./ack-outbox");

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
let processedJobsStore = null;
let ackOutboxStore = null;
let ackOutboxFlushTimer = null;
let ackOutboxFlushInFlight = false;
const pendingRetries = new Map();
/** Warn when free space below this or below DISK_WARN_PERCENT_FREE. */
const DISK_WARN_BYTES = 500 * 1024 * 1024;
const DISK_CRITICAL_BYTES = 150 * 1024 * 1024;
const DISK_WARN_PERCENT_FREE = 5;

function getJobsStore() {
  if (!jobsStore) jobsStore = createPrintJobsStore(app.getPath("userData"));
  return jobsStore;
}

function getProcessedJobs() {
  if (!processedJobsStore) {
    processedJobsStore = createProcessedJobsStore({
      filePath: path.join(app.getPath("userData"), "processed-jobs.json"),
    });
  }
  return processedJobsStore;
}

function getAckOutbox() {
  if (!ackOutboxStore) {
    ackOutboxStore = createAckOutbox({
      filePath: path.join(app.getPath("userData"), "ack-outbox.json"),
      onCorrupt: (info) => {
        try {
          if (typeof log === "function") {
            log(
              `Ack outbox JSON is corrupt — quarantined to ${info.quarantinedPath}. ` +
                `Starting a fresh outbox. Pending server acks from the corrupt file were NOT recovered ` +
                `(parse error: ${info.error || "unknown"}).`,
              "❌"
            );
          } else {
            console.error(
              "Ack outbox corrupt; quarantined to",
              info.quarantinedPath,
              info.error
            );
          }
        } catch (_) {}
        try {
          if (typeof pushState === "function") pushState();
        } catch (_) {}
      },
    });
  }
  return ackOutboxStore;
}

/**
 * N2: mark processed (never reprint), durable-enqueue server ack, then Rabbit may ack.
 * HTTP delivery is retried by flushAckOutbox.
 */
function finalizeServerAck({ serverJobId, status, reason, printerExternalId }) {
  if (!serverJobId) return null;
  getProcessedJobs().mark(serverJobId);
  const entry = getAckOutbox().enqueue({
    jobId: serverJobId,
    status: status === "printed" ? "printed" : "failed",
    reason: reason || null,
    printerExternalId: printerExternalId || null,
  });
  scheduleAckOutboxFlush(0);
  return entry;
}

function scheduleAckOutboxFlush(delayMs) {
  const delay = delayMs != null ? Number(delayMs) : 0;
  if (ackOutboxFlushTimer) clearTimeout(ackOutboxFlushTimer);
  ackOutboxFlushTimer = setTimeout(() => {
    ackOutboxFlushTimer = null;
    flushAckOutbox().catch((err) => {
      try {
        log("Ack outbox flush error: " + (err.message || String(err)), "⚠️");
      } catch (_) {}
    });
  }, Number.isFinite(delay) && delay > 0 ? delay : 0);
}

async function flushAckOutbox() {
  if (ackOutboxFlushInFlight) return { skipped: true };
  ackOutboxFlushInFlight = true;
  let flushed = 0;
  let deferred = 0;
  try {
    const outbox = getAckOutbox();
    const due = outbox.listDue(Date.now());
    if (!due.length) return { flushed: 0, deferred: 0 };
    const sp = getStationPrinting();
    for (const entry of due) {
      let result;
      try {
        if (entry.status === "printed") {
          result = await sp.ackPrinted(entry.jobId, {
            printerExternalId: entry.printerExternalId,
          });
        } else {
          result = await sp.ackFailed(entry.jobId, entry.reason || "print_failed", {
            printerExternalId: entry.printerExternalId,
          });
        }
      } catch (err) {
        result = {
          ok: false,
          status: null,
          error: { message: err.message || String(err) },
        };
      }
      if (result && result.skipped) {
        // No token yet — defer
        outbox.markAttempt(entry.jobId, {
          ok: false,
          status: null,
          error: "skipped_no_token",
        });
        deferred += 1;
        continue;
      }
      const outcome = outbox.markAttempt(entry.jobId, {
        ok: Boolean(result && result.ok),
        status: result && result.status,
        error:
          (result && result.message) ||
          (result && result.error && result.error.message) ||
          null,
        retryAfterMs: result && result.retryAfterMs,
      });
      if (outcome && outcome.removed) {
        flushed += 1;
        if (outcome.exhausted || outcome.deadLettered) {
          const code =
            (result && result.code) ||
            (result && result.error && result.error.code) ||
            null;
          const codePart = code ? ` code=${code}` : "";
          log(
            `Server ack outbox dead-lettered job_id=${entry.jobId} status=${entry.status} ` +
              `after ${outcome.entry.attempts} attempts ` +
              `(last HTTP ${outcome.entry.lastStatus != null ? outcome.entry.lastStatus : "n/a"}${codePart}: ` +
              `${outcome.entry.lastError || "error"}) — slot released.`,
            "⚠️"
          );
        } else if (outcome.ok) {
          log(
            `Server ack outbox delivered job_id=${entry.jobId} status=${entry.status}`,
            "✅"
          );
        }
      } else {
        deferred += 1;
        const attempts = outcome && outcome.entry ? outcome.entry.attempts : 0;
        if (shouldLogRetryFailure(attempts)) {
          const st = result && result.status != null ? result.status : "n/a";
          const errMsg =
            (result && result.message) ||
            (result && result.error && result.error.message) ||
            "error";
          log(
            `Server ack outbox defer job_id=${entry.jobId} attempt=${attempts} HTTP ${st}: ${errMsg}`,
            "⚠️"
          );
        }
      }
      // L2/L3: ACK 401 immediate unpair; soft 403 counts toward threshold (same as HB/sync).
      if (result && !result.ok && typeof sp.handleAuthFailure === "function") {
        sp.handleAuthFailure(result, "ack_unauthorized");
      }
    }
    // Schedule next due
    const remaining = outbox.listAll();
    if (remaining.length) {
      const nextAt = Math.min(...remaining.map((e) => e.nextAttemptAt || 0));
      const wait = Math.max(250, nextAt - Date.now());
      scheduleAckOutboxFlush(wait);
    }
    return { flushed, deferred };
  } finally {
    ackOutboxFlushInFlight = false;
  }
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

async function fetchPdfUrl(url, authToken, opts = {}) {
  const cfg = readUserConfig();
  let apiBase = opts.apiBase || cfg.agent_api_base || "";
  try {
    if (!apiBase && getStationPrinting().api && typeof getStationPrinting().api.getApiBase === "function") {
      apiBase = getStationPrinting().api.getApiBase() || "";
    }
  } catch (_) {}
  const pdfHost = opts.pdfHost || cfg.pdf_host || null;
  let built;
  try {
    built = buildPdfAxiosConfig({
      pdfUrl: url,
      authToken,
      pdfHost,
      apiBase,
      allowedPdfHosts: opts.allowedPdfHosts,
      maxBytes: opts.maxBytes != null ? opts.maxBytes : DEFAULT_MAX_PDF_BYTES,
    });
  } catch (err) {
    if (err && err.code === "PDF_HOST_NOT_ALLOWED") {
      log(
        `PDF fetch refused: host not allowed (${err.origin || "unknown"}). No GET; ack PDF_HOST_NOT_ALLOWED.`,
        "🔒"
      );
      const denied = new Error(STATION_ERROR_CODES.PDF_HOST_NOT_ALLOWED || "PDF_HOST_NOT_ALLOWED");
      denied.code = STATION_ERROR_CODES.PDF_HOST_NOT_ALLOWED || "PDF_HOST_NOT_ALLOWED";
      denied.retryable = false;
      denied.origin = err.origin;
      throw denied;
    }
    throw err;
  }
  // buildPdfAxiosConfig asserts allowlist — host_not_allowed throws PDF_HOST_NOT_ALLOWED (no GET)
  if (built.sendAuth) {
    log(
      `PDF fetch: Bearer attached (host ${built.decision.origin} matches pdf_host allowlist).`,
      "🔒"
    );
  } else {
    log(
      `PDF fetch: host allowed but Bearer withheld (${built.decision.reason}).`,
      "🔒"
    );
  }
  try {
    return await axios.get(built.url, built.axiosConfig);
  } catch (err) {
    if (err && err.code === "PDF_HOST_NOT_ALLOWED") throw err;
    if (isPdfTooLargeError(err)) {
      const tooLarge = new Error(STATION_ERROR_CODES.PDF_TOO_LARGE || "PDF_TOO_LARGE");
      tooLarge.code = STATION_ERROR_CODES.PDF_TOO_LARGE || "PDF_TOO_LARGE";
      tooLarge.retryable = false;
      throw tooLarge;
    }
    throw err;
  }
}

function pdfUrlExpiredError(status) {
  const err = new Error(STATION_ERROR_CODES.PDF_URL_EXPIRED || "PDF_URL_EXPIRED");
  err.code = STATION_ERROR_CODES.PDF_URL_EXPIRED || "PDF_URL_EXPIRED";
  err.httpStatus = status;
  err.retryable = false;
  return err;
}

async function saveIncomingPdf(store, jobId, filePath, isUrl, opts = {}) {
  await ensureSpaceForIncomingPdf();
  const rawBase = derivePdfBasename(filePath, isUrl);
  const safeBase = rawBase.replace(/[^a-zA-Z0-9._-]/g, "_") || "order.pdf";
  const dest = path.join(store.incoming, `${jobId}_${safeBase}`);
  const authToken = opts.authToken != null ? opts.authToken : null;
  try {
    if (isUrl) {
      const res = await fetchPdfUrl(filePath, authToken, opts);
      if (classifyPdfUrlHttpStatus(res.status).expired) {
        throw pdfUrlExpiredError(res.status);
      }
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`PDF download failed (HTTP ${res.status})`);
      }
      const buf = Buffer.from(res.data);
      if (buf.length > DEFAULT_MAX_PDF_BYTES) {
        const tooLarge = new Error(STATION_ERROR_CODES.PDF_TOO_LARGE || "PDF_TOO_LARGE");
        tooLarge.code = STATION_ERROR_CODES.PDF_TOO_LARGE || "PDF_TOO_LARGE";
        tooLarge.retryable = false;
        throw tooLarge;
      }
      fs.writeFileSync(dest, buf);
    } else {
      const resolved = path.resolve(filePath);
      if (!fs.existsSync(resolved)) throw new Error("Local PDF not found: " + resolved);
      fs.copyFileSync(resolved, dest);
    }
  } catch (err) {
    if (err && err.code === "PDF_URL_EXPIRED") throw err;
    if (err && err.code === "PDF_HOST_NOT_ALLOWED") throw err;
    if (err && err.code === "PDF_TOO_LARGE") throw err;
    if (isNoSpaceError(err)) {
      await emergencyDiskCleanup();
      await refreshDiskSpaceStatus({ silent: true });
      if (state.diskSpace.status === "critical") {
        throw new Error("Disk full — could not save PDF. Freed old logs/jobs; free more space and retry.");
      }
      if (isUrl) {
        const res = await fetchPdfUrl(filePath, authToken, opts);
        if (classifyPdfUrlHttpStatus(res.status).expired) {
          throw pdfUrlExpiredError(res.status);
        }
        if (res.status < 200 || res.status >= 300) {
          throw new Error(`PDF download failed (HTTP ${res.status})`);
        }
        const buf = Buffer.from(res.data);
        if (buf.length > DEFAULT_MAX_PDF_BYTES) {
          const tooLarge = new Error(STATION_ERROR_CODES.PDF_TOO_LARGE || "PDF_TOO_LARGE");
          tooLarge.code = STATION_ERROR_CODES.PDF_TOO_LARGE || "PDF_TOO_LARGE";
          tooLarge.retryable = false;
          throw tooLarge;
        }
        fs.writeFileSync(dest, buf);
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

/**
 * Decode pdf_base64 (raw or data-URI) and write to incoming/.
 * Validates that the payload looks like a PDF (%PDF header).
 */
async function saveIncomingPdfFromBase64(store, jobId, base64Raw, preferredName) {
  await ensureSpaceForIncomingPdf();
  // Normalize data-URI / whitespace, then reject oversized payloads BEFORE decode (M1/L4).
  let b64;
  try {
    b64 = normalizePdfBase64Input(base64Raw);
  } catch (normErr) {
    if (normErr && normErr.code === (STATION_ERROR_CODES.INVALID_PDF || "INVALID_PDF")) {
      const invalid = new Error(STATION_ERROR_CODES.INVALID_PDF || "INVALID_PDF");
      invalid.code = STATION_ERROR_CODES.INVALID_PDF || "INVALID_PDF";
      invalid.retryable = false;
      throw invalid;
    }
    throw normErr;
  }
  const maxB64 = BASE64_MAX_PDF_BYTES || 5 * 1024 * 1024;
  try {
    assertBase64WithinDecodedMax(b64, maxB64);
  } catch (sizeErr) {
    if (sizeErr && sizeErr.code === (STATION_ERROR_CODES.PDF_TOO_LARGE || "PDF_TOO_LARGE")) {
      const tooLarge = new Error(STATION_ERROR_CODES.PDF_TOO_LARGE || "PDF_TOO_LARGE");
      tooLarge.code = STATION_ERROR_CODES.PDF_TOO_LARGE || "PDF_TOO_LARGE";
      tooLarge.retryable = false;
      throw tooLarge;
    }
    throw sizeErr;
  }

  let buf;
  try {
    buf = Buffer.from(b64, "base64");
  } catch (err) {
    throw new Error("Invalid pdf_base64 encoding: " + (err.message || String(err)));
  }
  if (!buf.length) throw new Error("Decoded pdf_base64 is empty");
  // Defense in depth: still enforce after decode (padding / estimate edge cases).
  if (buf.length > maxB64) {
    const tooLarge = new Error(STATION_ERROR_CODES.PDF_TOO_LARGE || "PDF_TOO_LARGE");
    tooLarge.code = STATION_ERROR_CODES.PDF_TOO_LARGE || "PDF_TOO_LARGE";
    tooLarge.retryable = false;
    throw tooLarge;
  }
  // PDF files start with %PDF — terminal INVALID_PDF (not free text / retryable)
  const header = buf.slice(0, 4).toString("latin1");
  if (header !== "%PDF") {
    const invalid = new Error(
      STATION_ERROR_CODES.INVALID_PDF || "INVALID_PDF"
    );
    invalid.code = STATION_ERROR_CODES.INVALID_PDF || "INVALID_PDF";
    throw invalid;
  }

  const rawBase = preferredName || `order-${Date.now()}.pdf`;
  const safeBase = String(rawBase).replace(/[^a-zA-Z0-9._-]/g, "_") || "order.pdf";
  const withExt = /\.pdf$/i.test(safeBase) ? safeBase : `${safeBase}.pdf`;
  const dest = path.join(store.incoming, `${jobId}_${withExt}`);

  try {
    fs.writeFileSync(dest, buf);
  } catch (err) {
    if (isNoSpaceError(err)) {
      await emergencyDiskCleanup();
      await refreshDiskSpaceStatus({ silent: true });
      if (state.diskSpace.status === "critical") {
        throw new Error("Disk full — could not save PDF. Freed old logs/jobs; free more space and retry.");
      }
      fs.writeFileSync(dest, buf);
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

async function moveJobToDlq(jobId, errMsg) {
  const store = getJobsStore();
  const job = store.findById(jobId);
  if (!job) return "dlq";
  clearRetryTimer(jobId);
  if (job.serverJobId) {
    finalizeServerAck({
      serverJobId: job.serverJobId,
      status: "failed",
      reason: errMsg || "print_failed",
      printerExternalId: job.printerExternalId || null,
    });
  }
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
  return "dlq";
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

async function onPrintFailure(jobId, errMsg) {
  const store = getJobsStore();
  const job = store.findById(jobId);
  if (!job) return "missing";

  const attemptJustFinished = job.attemptNumber || 0;
  if (attemptJustFinished >= MAX_ATTEMPTS) {
    return moveJobToDlq(jobId, errMsg);
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
  // Await retry so Rabbit ack-after-print can wait for the full attempt cycle.
  await new Promise((resolve) => {
    const t = setTimeout(resolve, delay);
    pendingRetries.set(jobId, t);
  });
  pendingRetries.delete(jobId);
  return runPrintAttempt(jobId);
}

async function runPrintAttempt(jobId) {
  const store = getJobsStore();
  const job = store.findById(jobId);
  if (!job || job.status === "completed" || job.status === "dlq") {
    return job && job.status ? job.status : "missing";
  }

  const printerName = (job.printerName && String(job.printerName).trim()) || state.defaultPrinter;
  if (!printerName) {
    store.upsert({ ...job, status: "failed-setup", lastError: "No default printer selected" });
    syncJobsToState();
    pushState();
    log(`Job ${job.file}: no default printer — cannot print.`, "❌");
    if (job.serverJobId) {
      finalizeServerAck({
        serverJobId: job.serverJobId,
        status: "failed",
        reason: "no_printer",
        printerExternalId: job.printerExternalId || null,
      });
    }
    return "failed-setup";
  }

  if (!job.localPath || !fs.existsSync(job.localPath)) {
    return onPrintFailure(jobId, "Saved PDF missing on disk");
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
    if (job.serverJobId) {
      finalizeServerAck({
        serverJobId: job.serverJobId,
        status: "failed",
        reason: "print_requires_windows",
        printerExternalId: job.printerExternalId || null,
      });
    }
    return "failed-setup";
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
      if (j.serverJobId) {
        // Mark processed immediately so a crash before outbox write cannot double-print.
        getProcessedJobs().mark(j.serverJobId);
        finalizeServerAck({
          serverJobId: j.serverJobId,
          status: "printed",
          printerExternalId: j.printerExternalId || null,
        });
      }
      syncJobsToState();
      pushState();
      return "completed";
    }

    const reason =
      outcome === "error"
        ? "Print queue reported an error"
        : outcome === "timeout"
          ? "Print job tracking timed out"
          : "Print did not complete successfully";
    return onPrintFailure(jobId, reason);
  } catch (err) {
    return onPrintFailure(jobId, err.message || String(err));
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
    // Always seal — never rewrite legacy plaintext secrets as-is (I1/M1)
    writeSealedConfigFile(configPath, merged);
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
    const branchId = cfg.branch_id != null ? String(cfg.branch_id).trim() : "";
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
      channel: "",
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
      branchId: "",
      channel: "",
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
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    const { cfg, migrated, wipedPlaintext, encryptionAvailable, persistPatch } =
      migrateAndLoadSecrets(raw);
    if (persistPatch) {
      try {
        // Single sealing writer — strips/encrypts secrets; never plaintext
        writeSealedConfigFile(CONFIG_PATH, { ...raw, ...persistPatch, ...cfg });
        try {
          if (typeof log === "function") {
            if (migrated) {
              log("Migrated agent_token / rabbit_password into Electron safeStorage.", "🔒");
            }
            if (wipedPlaintext && !encryptionAvailable) {
              log(
                "Secure storage unavailable — removed plaintext secrets from disk; keeping them in memory for this session only. Re-pair required after restart.",
                "⚠️"
              );
            } else if (wipedPlaintext) {
              log("Removed legacy plaintext secrets from disk after migration.", "🔒");
            }
            if (!encryptionAvailable) {
              log(
                "OS secure storage (safeStorage) unavailable — secrets will not be persisted; app will re-pair on restart.",
                "⚠️"
              );
            }
          }
        } catch (_) {}
      } catch (_) {}
    }
    // Ensure in-memory session secrets are visible on the config object
    for (const key of SECRET_KEYS) {
      if (!cfg[key]) {
        const s = getSessionSecret(key);
        if (s) cfg[key] = s;
      }
    }
    cfg.secrets_encryption_unavailable = !isEncryptionAvailable();
    return cfg;
  } catch (_) {
    return { secrets_encryption_unavailable: !isEncryptionAvailable() };
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
  if ("queue_precondition_hint" in partial && !partial.queue_precondition_hint) {
    delete next.queue_precondition_hint;
  }
  if ("log_retention_days" in partial || "job_retention_days" in partial) {
    delete next.retention_days;
  }
  // Single sealing writer — encrypt when available; never plaintext; session-only otherwise.
  writeSealedConfigFile(CONFIG_PATH, next);
}

const RABBITMQ_HEARTBEAT_SECONDS = 15;
const BUILTIN_RABBIT_DEFAULTS = {
  host: "",
  port: null,
  username: "",
  password: "",
  exchange: "",
  routingKey: "",
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
 * First install ships empty host/user/password/exchange/routingKey (no silent prefills).
 */
function getMergedRabbitDefaultLayer() {
  const file = readRabbitDefaultsFromFile() || {};
  const envPort = parseRabbitPort(envTrim("RABBITMQ_DEFAULT_PORT"));
  const filePort = parseRabbitPort(file.port);
  const builtinPort = parseRabbitPort(BUILTIN_RABBIT_DEFAULTS.port);
  const port = envPort ?? filePort ?? builtinPort ?? 5672;
  return {
    protocol: "amqp",
    host: firstNonEmptyStr(envTrim("RABBITMQ_DEFAULT_HOST"), file.host, BUILTIN_RABBIT_DEFAULTS.host),
    port,
    username: firstNonEmptyStr(envTrim("RABBITMQ_DEFAULT_USERNAME"), file.username, BUILTIN_RABBIT_DEFAULTS.username),
    password: firstNonEmptyStr(envTrim("RABBITMQ_DEFAULT_PASSWORD"), file.password, BUILTIN_RABBIT_DEFAULTS.password),
    exchange: firstNonEmptyStr(
      envTrim("RABBITMQ_DEFAULT_EXCHANGE"),
      file.exchange,
      BUILTIN_RABBIT_DEFAULTS.exchange
    ),
    routingKey: firstNonEmptyStr(
      envTrim("RABBITMQ_DEFAULT_ROUTING_KEY"),
      file.routingKey,
      file.routing_key,
      BUILTIN_RABBIT_DEFAULTS.routingKey
    ),
  };
}

function getRabbitEffectiveHost() {
  const cfg = readUserConfig();
  if (cfg.rabbit_host != null && String(cfg.rabbit_host).trim() !== "") {
    return String(cfg.rabbit_host).trim();
  }
  return getMergedRabbitDefaultLayer().host || "";
}

function getRoutingKeyTemplate() {
  const cfg = readUserConfig();
  if (cfg.rabbit_routing_key != null && String(cfg.rabbit_routing_key).trim() !== "") {
    return String(cfg.rabbit_routing_key).trim();
  }
  return getMergedRabbitDefaultLayer().routingKey || "";
}

/** Resolve template like orders.{branch_id} → orders.147. Empty template + branch → legacy branch.<id>. */
function resolveRoutingKey(template, branchId) {
  const id = String(branchId || "").trim();
  const t = String(template || "").trim();
  if (!t) return id ? `branch.${id}` : "";
  if (!id && /\{branch[_-]?id\}|\{branch\}/i.test(t)) return "";
  return t
    .replace(/\{branch_id\}/gi, id)
    .replace(/\{branchId\}/g, id)
    .replace(/\{branch\}/gi, id);
}

function isRabbitBrokerConfigured() {
  return getRabbitEffectiveHost() !== "";
}

/** Host + branch + resolvable routing key required before consuming. */
function isRabbitReadyToConsume() {
  if (!isRabbitBrokerConfigured()) return false;
  const branchId = String(state.branchId || "").trim();
  if (!branchId) return false;
  return resolveRoutingKey(getRoutingKeyTemplate(), branchId) !== "";
}

function buildRabbitOptions() {
  const cfg = readUserConfig();
  const layer = getMergedRabbitDefaultLayer();
  const host = getRabbitEffectiveHost();
  const tls = cfg.rabbit_tls === true;
  const protocol = tls ? "amqps" : layer.protocol || "amqp";
  if (!host) {
    return {
      configured: false,
      protocol,
      host: "",
      port: "",
      username: "",
      password: "",
      exchange: "",
      routingKey: "",
      url: "",
      tls,
    };
  }
  let port = tls ? 5671 : layer.port;
  if (cfg.rabbit_port != null && String(cfg.rabbit_port).trim() !== "") {
    const n = Number(cfg.rabbit_port);
    if (Number.isFinite(n) && n > 0 && n < 65536) port = Math.floor(n);
  } else if (cfg.rabbit_tls != null) {
    port = tls ? 5671 : 5672;
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
  const routingKeyTemplate =
    cfg.rabbit_routing_key != null && String(cfg.rabbit_routing_key).trim() !== ""
      ? String(cfg.rabbit_routing_key).trim()
      : layer.routingKey;
  const encodedUser = encodeURIComponent(username);
  const encodedPass = encodeURIComponent(password);
  let vhost = "/";
  if (cfg.rabbit_vhost != null && String(cfg.rabbit_vhost).trim() !== "") {
    vhost = String(cfg.rabbit_vhost);
  }
  // amqp URL path is the vhost; encode so "/" stays %2F when non-default
  const vhostPath =
    vhost === "/" ? "/" : "/" + encodeURIComponent(vhost).replace(/%2F/gi, "%2F");
  const url =
    `${protocol}://${encodedUser}:${encodedPass}@${host}:${port}${vhostPath}` +
    `?heartbeat=${RABBITMQ_HEARTBEAT_SECONDS}`;
  const exchangeType =
    cfg.rabbit_exchange_type != null && String(cfg.rabbit_exchange_type).trim() !== ""
      ? String(cfg.rabbit_exchange_type).trim()
      : "topic";
  return {
    configured: true,
    protocol,
    tls,
    host,
    port,
    username,
    password,
    exchange,
    exchangeType,
    routingKey: routingKeyTemplate,
    vhost,
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

// ─── Station printing (Option A — single print host) ───────────────────────────
let stationPrinting = null;
let agentHeartbeatTimer = null;
let agentHeartbeatSoonTimer = null;
/** Consecutive liveness failures observed by main — drives soon-retry backoff (L1). */
let agentHeartbeatConsecutiveFailures = 0;
const AGENT_HEARTBEAT_MS = STATION_PRINT_ASSUMPTIONS.heartbeatIntervalMs || 30000;

function getStationPrinting() {
  if (stationPrinting) return stationPrinting;
  stationPrinting = createStationPrintingController({
    readConfig: readUserConfig,
    writeConfig: saveUserConfig,
    log,
    onStateChange: () => {
      try { pushState(); } catch (_) {}
    },
  });
  return stationPrinting;
}

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
  channel: resolveRoutingKey(getRoutingKeyTemplate(), branchId) || initialChannel || "",
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
  // Station printing host state (mirrors controller; refreshed via pushState)
  stationPrinting: null,
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
/** Suppress reconnect handlers while startRabbit is declaring / migrating the queue. */
let rabbitStarting = false;
/**
 * Set when applyBranchId skips reconnect while rabbitStarting (r11 M1).
 * Flushed from startRabbit's finally via an outer startRabbit (no nested await).
 */
let pendingBranchReconnect = false;
/** Serialize startRabbit so Settings save + reconnect don't race-migrate. */
let rabbitStartChain = Promise.resolve();
let networkMonitorTimer = null;
let networkMonitorInstalled = false;
let lastKnownOnline = null;
let lastForceReconnectAt = 0;

/** Reconnect pacing: keep delays short so venues recover quickly after Wi‑Fi blips. */
const RABBIT_RECONNECT_BASE_MS = 1000;
const RABBIT_RECONNECT_CAP_ONLINE_MS = 15000;
const RABBIT_RECONNECT_CAP_OFFLINE_MS = 30000;
const RABBIT_CONNECT_TIMEOUT_MS = 10000;
const RABBIT_HEALTH_INTERVAL_MS = 5000;
const NETWORK_POLL_MS = 1500;
const FORCE_RECONNECT_DEBOUNCE_MS = 2000;
const BROKER_PROBE_TIMEOUT_MS = 2500;

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
    try {
      log("Uncaught error (agent will restart if enabled): " + (err && err.message ? err.message : String(err)), "❌");
    } catch (_) {}
    maybeRelaunch("uncaughtException", err);
  });

  process.on("unhandledRejection", (reason) => {
    const detail = reason && reason.message ? reason.message : String(reason);
    try {
      log("Unhandled promise rejection (agent will restart if enabled): " + detail, "❌");
    } catch (_) {}
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
  const routingTemplate = getRoutingKeyTemplate();
  const resolvedChannel =
    resolveRoutingKey(routingTemplate, state.branchId) || state.channel || "";
  return {
    ...state,
    channel: resolvedChannel,
    rabbitHost: rabbitOpts.host,
    rabbitPort: rabbitOpts.port,
    rabbitUsername: rabbitOpts.username,
    rabbitExchange: rabbitOpts.exchange,
    rabbitRoutingKey: routingTemplate,
    rabbitAuthConfigured,
    rabbitManualOverride: Boolean(readUserConfig().rabbit_manual_override),
    appVersion: app.getVersion(),
    userDataPath: app.getPath("userData"),
    platform: process.platform,
    printJobsRoot: path.join(app.getPath("userData"), "print-jobs"),
    stationPrinting: (() => {
      try {
        return getStationPrinting().publicHostState();
      } catch (_) {
        return null;
      }
    })(),
    ackOutboxCorrupt: (() => {
      try {
        return getAckOutbox().getCorruptInfo();
      } catch (_) {
        return null;
      }
    })(),
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
  if (id === "") {
    state.branchId = "";
    state.channel = "";
    saveUserConfig({ branch_id: "" });
    try {
      const sp = getStationPrinting();
      if (sp && typeof sp.allowManualRegister === "function") sp.allowManualRegister();
    } catch (_) {}
    log("Branch ID cleared — set a branch before consuming orders.", "📌");
    pushState();
    resetRabbitReconnectBackoff();
    await startRabbit();
    return { ok: true, branchId: "", channel: "" };
  }
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
  // M1/N3: never write readUserConfig() raw — always seal via saveUserConfig
  saveUserConfig({
    log_retention_days: state.logRetentionDays,
    job_retention_days: state.jobRetentionDays,
  });
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
  const routingKey = opts?.routingKey != null ? String(opts.routingKey).trim() : "";
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
  if (!routingKey) {
    return { ok: false, error: "Routing key is required (e.g. orders.{branch_id} or branch.{branch_id})." };
  }
  if (passwordMode === "set" && !String(passwordNew).trim()) {
    return { ok: false, error: "Enter a new password, or turn off “Set new password”." };
  }

  const patch = {
    rabbit_host: host,
    rabbit_port: port,
    rabbit_username: username,
    rabbit_exchange: exchange,
    rabbit_routing_key: routingKey,
    rabbit_manual_override: true,
  };
  if (passwordMode === "clear") {
    patch.rabbit_password = "";
  } else if (passwordMode === "set") {
    patch.rabbit_password = passwordNew;
  }

  saveUserConfig(patch);
  state.channel = resolveRoutingKey(routingKey, state.branchId);
  log(`RabbitMQ settings saved (${host}:${port}) — reconnecting…`, "⚙️");
  resetRabbitReconnectBackoff();
  await startRabbit();
  pushState();
  return { ok: true };
});

ipcMain.handle("set-rabbit-manual-override", async (_e, enabled) => {
  const sp = getStationPrinting();
  const result = sp.setRabbitManualOverride(Boolean(enabled));
  if (result && result.rabbitChanged) {
    resetRabbitReconnectBackoff();
    await startRabbit();
  }
  pushState();
  return {
    ok: true,
    rabbitManualOverride: Boolean(result && result.rabbitManualOverride),
    rabbitChanged: Boolean(result && result.rabbitChanged),
  };
});

ipcMain.handle("set-agent-api-settings", async (_e, opts) => {
  try {
    const o = opts && typeof opts === "object" ? opts : {};
    const sp = getStationPrinting();
    if (Object.prototype.hasOwnProperty.call(o, "apiBase")) {
      sp.setApiBase(o.apiBase);
    }
    if (Object.prototype.hasOwnProperty.call(o, "deviceLabel")) {
      sp.setDeviceLabel(o.deviceLabel);
    }
    if (Object.prototype.hasOwnProperty.call(o, "pairingCode")) {
      sp.setPairingCode(o.pairingCode);
    }
    pushState();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle("join-as-backup-device", async () => {
  try {
    const sp = getStationPrinting();
    // Manual only — never from ensureSession. allowManualRegister is inside joinAsBackupDevice.
    const cfg = readUserConfig();
    if (!(cfg.pairing_code && String(cfg.pairing_code).trim())) {
      const pairingError = {
        code: "PAIRING_CODE_REQUIRED",
        message: "Pairing code is required.",
      };
      pushState();
      return {
        ok: false,
        error: pairingError.message,
        code: pairingError.code,
        pairingError,
        stationPrinting: sp.publicHostState(),
      };
    }
    const result = await sp.joinAsBackupDevice({ branchId: cfg.branch_id });
    pushState();
    const st = sp.publicHostState();
    if (!result || !result.ok) {
      return {
        ok: false,
        error:
          (result && result.pairingError && result.pairingError.message) ||
          (result && result.error && result.error.message) ||
          (st.lastRegisterError && st.lastRegisterError.message) ||
          (st.hostConflict && st.hostConflict.message) ||
          "Could not join as backup device.",
        code:
          (result && (result.code || (result.pairingError && result.pairingError.code))) ||
          (st.lastRegisterError && st.lastRegisterError.code) ||
          (st.hostConflict && st.hostConflict.code) ||
          "JOIN_BACKUP_FAILED",
        pairingError: (result && result.pairingError) || st.lastRegisterError || null,
        stationPrinting: st,
      };
    }
    return {
      ok: true,
      role: "observer",
      isPrintHost: false,
      message:
        result.message ||
        "Connected as backup device. An admin can make this device the print host in Tawla Settings → Printing → Print devices.",
      stationPrinting: st,
    };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle("retry-print-host-register", async () => {
  try {
    const sp = getStationPrinting();
    sp.clearHostConflict();
    // v1.23: a user Retry/Connect may resend a code that auto-resume will not.
    sp.allowManualRegister();
    const cfg = readUserConfig();
    if (!(cfg.pairing_code && String(cfg.pairing_code).trim())) {
      const pairingError = {
        code: "PAIRING_CODE_REQUIRED",
        message: "Pairing code is required.",
      };
      pushState();
      return {
        ok: false,
        error: pairingError.message,
        code: pairingError.code,
        pairingError,
        stationPrinting: sp.publicHostState(),
      };
    }
    resetRabbitReconnectBackoff();
    await startRabbit();
    pushState();
    const st = sp.publicHostState();
    const cfgAfter = readUserConfig();
    const hasToken = Boolean(
      (sp.api && sp.api.getToken && sp.api.getToken()) ||
        (cfgAfter.agent_token && String(cfgAfter.agent_token).trim())
    );
    if (st.lastRegisterError) {
      return {
        ok: false,
        error: st.lastRegisterError.message,
        code: st.lastRegisterError.code,
        pairingError: st.lastRegisterError,
        stationPrinting: st,
      };
    }
    if (st.hostConflict) {
      return {
        ok: false,
        error: st.hostConflict.message,
        code: st.hostConflict.code,
        stationPrinting: st,
      };
    }
    // H1: never toast success unless register actually produced a token + host.
    if (!hasToken) {
      return {
        ok: false,
        error:
          "Register did not complete — check Server URL, pairing code, and network. Branch ID comes from the server after Connect.",
        code: "REGISTER_INCOMPLETE",
        stationPrinting: st,
      };
    }
    if (!st.isPrintHost) {
      return {
        ok: false,
        error:
          st.hostConflict && st.hostConflict.message
            ? st.hostConflict.message
            : "Registered, but this device is not the print host.",
        code: "NOT_PRINT_HOST",
        stationPrinting: st,
      };
    }
    return { ok: true, stationPrinting: st };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});


ipcMain.handle("scan-printers", async () => {
  try {
    await pollPrinters();
    const windows = state.printers || [];
    let lan = [];
    let progress = "";
    try {
      lan = await scanLanPrinters({
        onProgress: (msg) => {
          progress = String(msg || "");
        },
      });
    } catch (err) {
      progress = err && err.message ? err.message : String(err);
    }
    const candidates = discoveredPrinter.merge({ windows, lan });
    const managed = (() => {
      try {
        return getStationPrinting().printers.list();
      } catch (_) {
        return [];
      }
    })();
    const list = candidates.map((c) => ({
      ...c,
      alreadyAdded: discoveredPrinter.isAlreadyAdded(c, managed),
    }));
    return { ok: true, printers: list, progress, lanCount: lan.length, windowsCount: windows.length };
  } catch (err) {
    return { ok: false, error: err.message || String(err), printers: [] };
  }
});

ipcMain.handle("add-discovered-printer", async (_e, raw) => {
  try {
    const sp = getStationPrinting();
    const pub = sp.publicHostState ? sp.publicHostState() : {};
    const hostErr = lanHostValidation.assertPrintHostCanAdd(!!pub.isPrintHost);
    if (hostErr) {
      return {
        ok: false,
        error: hostErr,
        code: "NOT_PRINT_HOST",
      };
    }
    const o = raw && typeof raw === "object" ? raw : {};
    const candidate = {
      name: String(o.name || "").trim(),
      connection: String(o.connection || "lan").trim(),
      typeLabel: o.typeLabel,
      addressLabel: o.addressLabel,
      externalId: String(o.externalId || o.external_id || "").trim(),
      windows_name: String(o.windows_name || o.windowsName || "").trim(),
      host: String(o.host || "").trim(),
      port: o.port != null ? Number(o.port) : null,
      bluetoothAddress: String(o.bluetoothAddress || "").trim(),
      usbIdentity: String(o.usbIdentity || "").trim(),
    };
    const conn = String(candidate.connection || "").toLowerCase();
    // Skip LAN rules for Windows-spooler rows (win:… / windows_name), even if portName looked like LAN.
    const isWinSpooler =
      Boolean(candidate.windows_name) || /^win:/i.test(candidate.externalId || "");
    if ((conn === "lan" || conn === "network") && !isWinSpooler) {
      const portRaw =
        o.port != null && String(o.port).trim() !== ""
          ? String(o.port).trim()
          : candidate.port != null
            ? String(candidate.port)
            : "";
      const lanErr = lanHostValidation.validateManualLan(candidate.host, portRaw);
      if (lanErr) {
        return { ok: false, error: lanErr, code: "LAN_VALIDATION" };
      }
      const usePort = lanHostValidation.parsePortStrict(portRaw);
      candidate.port = usePort;
      // Keep external_id in sync with validated host:port
      candidate.externalId = discoveredPrinter.lanExternalId(candidate.host, usePort);
      candidate.addressLabel = candidate.host + ":" + usePort;
    }
    if (!candidate.externalId) {
      return { ok: false, error: "Missing printer external_id." };
    }
    const makeDefault = sp.printers.list().length === 0;
    const row = discoveredPrinter.toRegistryPrinter(candidate, { makeDefault });
    sp.printers.upsert(row);
    if (makeDefault) sp.setDefaultPrinter(row.external_id);
    try { saveUserConfig({ last_printer_list_sync_hash: "" }); } catch (_) {}
    await sp.syncPrintersToServer({ branchId: state.branchId, force: true });
    try { await sp.pushPrinterStatusesIfChanged(); } catch (_) {}
    pushState();
    return { ok: true, printers: sp.printers.list(), added: row };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle("set-printer-mapping", async (_e, opts) => {
  try {
    const o = opts && typeof opts === "object" ? opts : {};
    const sp = getStationPrinting();
    const pub = sp.publicHostState ? sp.publicHostState() : {};
    if (o.externalId && o.name) {
      const hostErr = lanHostValidation.assertPrintHostCanAdd(!!pub.isPrintHost);
      if (hostErr) {
        return { ok: false, error: hostErr, code: "NOT_PRINT_HOST" };
      }
      let connection = String(o.connection || "lan").trim() || "lan";
      let externalId = String(o.externalId).trim();
      let host = String(o.host || o.ip_address || "").trim();
      let port = o.port != null ? Number(o.port) : null;
      const replaceExternalId = String(o.replaceExternalId || "").trim() || null;
      if ((connection === "lan" || connection === "network") && host) {
        const portRaw = port != null && Number.isFinite(port) ? String(port) : String(o.port || "");
        const lanErr = lanHostValidation.validateManualLan(host, portRaw);
        if (lanErr) {
          return { ok: false, error: lanErr, code: "LAN_VALIDATION" };
        }
        const usePort = lanHostValidation.parsePortStrict(portRaw);
        port = usePort;
        externalId = discoveredPrinter.lanExternalId(host, usePort);
        connection = "lan";
      }
      const up = sp.upsertManagedPrinter(
        {
          external_id: externalId,
          name: String(o.name).trim(),
          windows_name: o.windowsName || o.name,
          connection,
          ip_address: host || null,
          port: port,
          is_default: !!o.isDefault,
        },
        { replaceExternalId },
      );
      if (!up.ok) return up;
    }
    if (o.defaultExternalId) sp.setDefaultPrinter(o.defaultExternalId);
    try { saveUserConfig({ last_printer_list_sync_hash: "" }); } catch (_) {}
    const sync = await sp.syncPrintersToServer({ branchId: state.branchId, force: true });
    try { await sp.pushPrinterStatusesIfChanged(); } catch (_) {}
    pushState();
    if (sync && sync.ok === false && !sync.skipped) {
      return {
        ok: false,
        error: (sync.error && sync.error.message) || sync.error || "Printer sync failed.",
        printers: sp.printers.list(),
      };
    }
    return { ok: true, printers: sp.printers.list() };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle("remove-printer", async (_e, opts) => {
  try {
    const o = opts && typeof opts === "object" ? opts : {};
    const externalId = String(o.externalId || o.external_id || "").trim();
    if (!externalId) return { ok: false, error: "Missing printer external_id." };
    const sp = getStationPrinting();
    const pub = sp.publicHostState ? sp.publicHostState() : {};
    const hostErr = lanHostValidation.assertPrintHostCanAdd(!!pub.isPrintHost);
    if (hostErr) {
      return { ok: false, error: hostErr, code: "NOT_PRINT_HOST" };
    }
    const removed = sp.removeManagedPrinter(externalId);
    if (!removed.ok) return removed;
    log(`Printer removed: ${externalId}`, "🖨️");
    try { saveUserConfig({ last_printer_list_sync_hash: "" }); } catch (_) {}
    const sync = await sp.syncPrintersToServer({ branchId: state.branchId, force: true });
    try { await sp.pushPrinterStatusesIfChanged(); } catch (_) {}
    pushState();
    if (sync && sync.ok === false && !sync.skipped) {
      const msg =
        (sync.error && sync.error.message) || sync.error || "Printer sync failed.";
      log(`Printer removed locally (${externalId}) but sync failed: ${msg}`, "⚠️");
      return { ok: false, error: msg, printers: sp.printers.list() };
    }
    return { ok: true, printers: sp.printers.list(), removed: removed.removed };
  } catch (err) {
    log(`Remove printer failed: ${err.message || err}`, "⚠️");
    return { ok: false, error: err.message || String(err) };
  }
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
  try {
    const sp = getStationPrinting();
    sp.syncWindowsPrinters(state.printers || []);
    if (state.defaultPrinter) sp.setDefaultPrinter(state.defaultPrinter);
  } catch (_) {}
}

// ─── RabbitMQ ─────────────────────────────────────────────────────────────────
function getRoutingForBranch(id) {
  const branch = String(id || "").trim();
  const routingKey = resolveRoutingKey(getRoutingKeyTemplate(), branch);
  // Queue from register.rabbit.queue, else printer.Branch.{branchId}
  let queueName = "";
  try {
    queueName = getStationPrinting().rabbitQueueName(branch);
  } catch (_) {
    queueName = branch ? `printer.Branch.${branch}` : "";
  }
  if (!queueName && branch) queueName = `printer.Branch.${branch}`;
  return {
    routingKey,
    queueName,
  };
}

function isInequivalentArgError(err) {
  const msg = err && err.message ? String(err.message) : String(err);
  return /PRECONDITION_FAILED|inequivalent arg/i.test(msg);
}

function wireRabbitChannel(channel) {
  channel.on("error", (err) => {
    if (channel !== rabbitChannel || rabbitStarting) return;
    log("RabbitMQ channel error: " + err.message, "❌");
    scheduleRabbitReconnect();
  });
  channel.on("close", () => {
    if (channel !== rabbitChannel || app.isQuiting || rabbitStarting) return;
    scheduleRabbitReconnect();
  });
}

/** Routing keys this branch should receive (configured key + common aliases). */
function branchBindingKeys(routingKey, branchId) {
  const keys = new Set();
  const primary = String(routingKey || "").trim();
  if (primary) keys.add(primary);
  const id = String(branchId || "").trim();
  if (id) {
    keys.add(`orders.${id}`);
    keys.add(`branch.${id}`);
  }
  return [...keys];
}

/**
 * Exchanges to bind. Server publishes to auto_print (see merchant .env);
 * older agents sometimes bound to "Orders Print" / orders.print instead.
 */
function exchangesToBind(configuredExchange) {
  const set = new Set();
  const configured = String(configuredExchange || "").trim();
  if (configured) set.add(configured);
  set.add("auto_print");
  set.add("orders.print");
  return [...set];
}

async function bindBranchQueue(channel, queueName, exchange, routingKey, branchId) {
  const keys = branchBindingKeys(routingKey, branchId);
  const exchanges = exchangesToBind(exchange);
  const bound = [];
  for (const ex of exchanges) {
    for (const key of keys) {
      try {
        await channel.bindQueue(queueName, ex, key);
        bound.push(`${ex} ← ${key}`);
      } catch (_) {
        // Exchange may not exist on this broker — skip.
      }
    }
  }
  return bound;
}

/** Short-lived broker connection for queue setup. */
async function withTempRabbitChannel(fn) {
  const opts = buildRabbitOptions();
  const connection = await amqp.connect(opts.url, {
    timeout: RABBIT_CONNECT_TIMEOUT_MS,
  });
  // amqplib emits "error" on 406 — without a listener Node crashes / relaunches.
  connection.on("error", () => {});
  connection.on("close", () => {});
  try {
    const channel = await connection.createChannel();
    channel.on("error", () => {});
    channel.on("close", () => {});
    try {
      return await fn(channel);
    } finally {
      try {
        await channel.close();
      } catch (_) {}
    }
  } finally {
    try {
      await connection.close();
    } catch (_) {}
  }
}

/**
 * Option A: durable queue with single-active-consumer.
 * Only the designated print host should consume; SAC is belt-and-suspenders
 * so a second connected agent is standby and receives nothing until the host disconnects.
 * HostOnlyPolicy still nacks stray messages if this device is not the host.
 */
async function ensureHostPrintQueue(queueName, exchange, routingKey, branchId) {
  const declare = getStationPrinting().rabbitQueueDeclareOptions
    ? getStationPrinting().rabbitQueueDeclareOptions()
    : { durable: true, arguments: { "x-single-active-consumer": true } };
  const queueOpts = {
    durable: declare.durable !== false,
    ...(declare.arguments && Object.keys(declare.arguments).length
      ? { arguments: declare.arguments }
      : { arguments: { "x-single-active-consumer": true } }),
  };

  try {
    const exType =
      (readUserConfig().rabbit_exchange_type &&
        String(readUserConfig().rabbit_exchange_type).trim()) ||
      "topic";
    await withTempRabbitChannel(async (ch) => {
      await ch.assertExchange(exchange, exType, { durable: true });
      await ch.assertQueue(queueName, queueOpts);
      const keys = await bindBranchQueue(ch, queueName, exchange, routingKey, branchId);
      log(
        `Queue ${queueName} ready (durable=${queueOpts.durable}, args=${JSON.stringify(queueOpts.arguments || {})}) — bound to ${exchange} [${keys.join(", ")}]. Only the print host consumes.`,
        "ℹ️"
      );
    });
    try {
      if (readUserConfig().queue_precondition_hint) {
        saveUserConfig({ queue_precondition_hint: null });
      }
    } catch (_) {}
    return;
  } catch (err) {
    if (!isInequivalentArgError(err)) throw err;
  }

  // M4: never delete the shared queue on PRECONDITION_FAILED (message-loss risk).
  // Match Android: passive attach + ops CTA (php artisan printing:redeclare-branch-queues).
  const hint =
    `Queue "${queueName}" exists with incompatible arguments (PRECONDITION_FAILED). ` +
    `The agent will NOT delete it. Ops: php artisan printing:redeclare-branch-queues`;
  log(hint, "⚠️");
  try {
    saveUserConfig({ queue_precondition_hint: hint });
  } catch (_) {}

  const exTypeMigrate =
    (readUserConfig().rabbit_exchange_type &&
      String(readUserConfig().rabbit_exchange_type).trim()) ||
    "topic";
  await withTempRabbitChannel(async (ch) => {
    await ch.assertExchange(exchange, exTypeMigrate, { durable: true });
    // Passive: verify queue exists without changing args
    await ch.checkQueue(queueName);
    try {
      const keys = await bindBranchQueue(ch, queueName, exchange, routingKey, branchId);
      log(
        `Passive attach to existing queue ${queueName} — bound to ${exchange} [${keys.join(", ")}]. Redeclare via artisan when ready.`,
        "ℹ️"
      );
    } catch (bindErr) {
      log(
        `Passive queue check ok but bind failed: ${bindErr && bindErr.message ? bindErr.message : String(bindErr)}. Redeclare via artisan.`,
        "⚠️"
      );
    }
  });
}

/** @deprecated Use ensureHostPrintQueue — kept as alias for any external callers. */
async function _ensureSharedPrintQueue(queueName, exchange, routingKey, branchId) {
  return ensureHostPrintQueue(queueName, exchange, routingKey, branchId);
}

function isNetworkLikelyOnline() {
  try {
    return net.isOnline();
  } catch (_) {
    return true;
  }
}

/** Quick TCP probe to broker host:port — true only when the port accepts a connection. */
function probeRabbitHostReachable() {
  const opts = buildRabbitOptions();
  if (!opts.configured || !opts.host) return Promise.resolve(false);
  const nodeNet = require("net");
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch (_) {}
      resolve(ok);
    };
    const socket = nodeNet.connect(
      { host: opts.host, port: opts.port },
      () => done(true)
    );
    socket.setTimeout(BROKER_PROBE_TIMEOUT_MS);
    socket.on("timeout", () => done(false));
    socket.on("error", () => done(false));
  });
}

/**
 * Cancel any pending backoff and reconnect immediately.
 * Used when OS network returns or the broker becomes reachable again —
 * so we do not wait out a long exponential delay after a brief outage.
 */
function forceRabbitReconnect(reason) {
  if (app.isQuiting || !isRabbitReadyToConsume()) return;
  if (rabbitStarting) return;
  if (state.rabbitmq === "connected" || state.rabbitmq === "connecting") return;
  const now = Date.now();
  if (now - lastForceReconnectAt < FORCE_RECONNECT_DEBOUNCE_MS) return;
  lastForceReconnectAt = now;
  if (rabbitReconnectTimer) {
    clearTimeout(rabbitReconnectTimer);
    rabbitReconnectTimer = null;
  }
  resetRabbitReconnectBackoff();
  log(`Reconnecting to RabbitMQ immediately (${reason}).`, "🔌");
  startRabbit().catch((err) =>
    log("RabbitMQ reconnect failed: " + (err.message || String(err)), "❌")
  );
}

function scheduleRabbitReconnect() {
  if (app.isQuiting || rabbitReconnectTimer) return;
  if (!isRabbitReadyToConsume()) return;
  state.rabbitmq = "error";
  pushState();
  const online = isNetworkLikelyOnline();
  const base = RABBIT_RECONNECT_BASE_MS;
  const cap = online ? RABBIT_RECONNECT_CAP_ONLINE_MS : RABBIT_RECONNECT_CAP_OFFLINE_MS;
  const delay = Math.min(cap, base * Math.pow(2, rabbitReconnectAttempt));
  rabbitReconnectAttempt = Math.min(rabbitReconnectAttempt + 1, 8);
  log(
    `RabbitMQ reconnect in ${Math.round(delay / 1000)}s (attempt ${rabbitReconnectAttempt}, network ${online ? "up" : "down"}).`,
    "⏳"
  );
  rabbitReconnectTimer = setTimeout(() => {
    rabbitReconnectTimer = null;
    startRabbit().catch((err) =>
      log("RabbitMQ reconnect failed: " + (err.message || String(err)), "❌")
    );
  }, delay);
}

/**
 * While disconnected, watch for network regain and broker reachability so we
 * reconnect as soon as possible instead of waiting for the next backoff tick.
 */
function setupNetworkOnlineMonitor() {
  if (networkMonitorInstalled) return;
  networkMonitorInstalled = true;
  lastKnownOnline = isNetworkLikelyOnline();

  networkMonitorTimer = setInterval(async () => {
    if (app.isQuiting || !isRabbitReadyToConsume()) return;

    const online = isNetworkLikelyOnline();
    const wasOnline = lastKnownOnline;
    lastKnownOnline = online;

    if (!wasOnline && online) {
      forceRabbitReconnect("network restored");
      return;
    }

    if (!online) return;
    if (state.rabbitmq !== "error") return;

    // Network is up but broker still disconnected — probe and cut short any long backoff.
    try {
      const reachable = await probeRabbitHostReachable();
      if (reachable && state.rabbitmq === "error" && !app.isQuiting) {
        forceRabbitReconnect("broker reachable again");
      }
    } catch (_) {}
  }, NETWORK_POLL_MS);
}

function clearNetworkOnlineMonitor() {
  if (networkMonitorTimer) {
    clearInterval(networkMonitorTimer);
    networkMonitorTimer = null;
  }
  networkMonitorInstalled = false;
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
  }, RABBIT_HEALTH_INTERVAL_MS);
}

function clearRabbitHealthCheck() {
  if (!rabbitHealthTimer) return;
  clearInterval(rabbitHealthTimer);
  rabbitHealthTimer = null;
}

function stopAgentHeartbeatLoop() {
  if (agentHeartbeatTimer) {
    clearInterval(agentHeartbeatTimer);
    agentHeartbeatTimer = null;
  }
  if (agentHeartbeatSoonTimer) {
    clearTimeout(agentHeartbeatSoonTimer);
    agentHeartbeatSoonTimer = null;
  }
  agentHeartbeatConsecutiveFailures = 0;
}

function scheduleAgentHeartbeatSoon(delayMs) {
  const ms = Math.max(0, Number(delayMs) || 0);
  if (agentHeartbeatSoonTimer) clearTimeout(agentHeartbeatSoonTimer);
  agentHeartbeatSoonTimer = setTimeout(() => {
    agentHeartbeatSoonTimer = null;
    runAgentHeartbeat().catch(() => {});
  }, ms);
}

function startAgentHeartbeatLoop() {
  stopAgentHeartbeatLoop();
  agentHeartbeatTimer = setInterval(() => {
    runAgentHeartbeat().catch(() => {});
  }, AGENT_HEARTBEAT_MS);
  // Immediate heartbeat so Delayed flush can start
  runAgentHeartbeat().catch(() => {});
}

async function runAgentHeartbeat() {
  if (app.isQuiting) return;
  const sp = getStationPrinting();
  const cfg = readUserConfig();
  if (!(cfg.agent_api_base && String(cfg.agent_api_base).trim())) return;
  if (!sp.api.getToken()) return;
  const result = await sp.heartbeat({ branchId: state.branchId });
  if (!result || result.skipped) return;
  if (result.authError || result.needsPairing) {
    agentHeartbeatConsecutiveFailures = 0;
    log(
      "Agent token rejected (401/403) — cleared session. Enter a fresh pairing code to register again.",
      "⚠️"
    );
    await stopRabbit();
    state.rabbitmq = "idle";
    pushState();
    return;
  }
  if (result.revoked) {
    agentHeartbeatConsecutiveFailures = 0;
    log("Host revoked on heartbeat — cancelling Rabbit consumer.", "⚠️");
    await stopRabbit();
    state.rabbitmq = "idle";
    pushState();
    return;
  }
  if (!result.ok) {
    agentHeartbeatConsecutiveFailures += 1;
    const n =
      Number(result.consecutiveHbFailures) > 0
        ? Number(result.consecutiveHbFailures)
        : agentHeartbeatConsecutiveFailures;
    agentHeartbeatConsecutiveFailures = n;
    // retrySoonMs is null for terminal 4xx — wait for the normal interval.
    if (result.retrySoonMs != null && Number(result.retrySoonMs) > 0) {
      scheduleAgentHeartbeatSoon(Number(result.retrySoonMs));
    } else if (result.retrySoonMs === undefined) {
      // Older path / missing classification — keep prior accelerated retry.
      scheduleAgentHeartbeatSoon(heartbeatFailureRetryMs(n));
    }
    return;
  }
  agentHeartbeatConsecutiveFailures = 0;
  if (result.promoted && result.shouldConsume) {
    log("Promoted to print host on heartbeat — starting Rabbit consumer.", "✅");
    if (result.flushPending || sp.flushPending) {
      log("Flushing Delayed jobs after reconnect as print host (server-side publish).", "⏱️");
      sp.markFlushDone();
    }
    resetRabbitReconnectBackoff();
    await startRabbit();
    return;
  }
  // v1.8: admin claim / promote may omit rabbit — poll soon for credentials (not an error).
  if (result.ok && result.waitingForRabbitCreds) {
    log(
      "Print host — waiting for Rabbit credentials from server (heartbeat again shortly).",
      "ℹ️"
    );
    state.rabbitmq = "idle";
    pushState();
    scheduleAgentHeartbeatSoon(2500);
    return;
  }
  if (result.ok && result.shouldConsume && sp.flushPending) {
    log(
      `Host heartbeat ok — pending_job_count=${result.pending_job_count || 0} (Delayed flush expected from server).`,
      "⏱️"
    );
    sp.markFlushDone();
  }
  if (result.ok && result.rabbitChanged && result.shouldConsume) {
    resetRabbitReconnectBackoff();
    await startRabbit();
  }
}

async function stopRabbit() {
  // Keep heartbeat running while registered; only clear on full quit via clear on before-quit.
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
  const run = async () => {
    /** Branch id captured when this start binds its routing key (r11 M1). */
    let boundForThisStart = "";
    await stopRabbit();
    let rabbitOpts = buildRabbitOptions();
    const cfgEarly = readUserConfig();
    const apiConfiguredEarly = Boolean(
      cfgEarly.agent_api_base && String(cfgEarly.agent_api_base).trim()
    );

    // H1: Connect may run with pairing + Server URL before any local Branch ID.
    // Register supplies branch_id; only require a local branch when we cannot register/resume.
    const hasPairingEarly = Boolean(
      cfgEarly.pairing_code && String(cfgEarly.pairing_code).trim()
    );
    let hasTokenEarly = false;
    try {
      const spEarly = getStationPrinting();
      hasTokenEarly = Boolean(
        (spEarly.api && spEarly.api.getToken && spEarly.api.getToken()) ||
          (cfgEarly.agent_token && String(cfgEarly.agent_token).trim())
      );
    } catch (_) {
      hasTokenEarly = Boolean(cfgEarly.agent_token && String(cfgEarly.agent_token).trim());
    }
    const canSessionWithoutBranch =
      apiConfiguredEarly && (hasPairingEarly || hasTokenEarly);

    if (!String(state.branchId || "").trim() && !canSessionWithoutBranch) {
      state.rabbitmq = "idle";
      state.channel = "";
      pushState();
      log("Branch ID not set — set Branch in Settings before consuming orders.", "ℹ️");
      return;
    }

    // When Agent API is configured, register first (may supply rabbit.*). Otherwise require local broker settings.
    if (!apiConfiguredEarly) {
      if (!String(state.branchId || "").trim()) {
        state.rabbitmq = "idle";
        state.channel = "";
        pushState();
        log("Branch ID not set — set Branch in Settings before consuming orders.", "ℹ️");
        return;
      }
      if (!rabbitOpts.configured) {
        state.rabbitmq = "idle";
        state.channel = resolveRoutingKey(getRoutingKeyTemplate(), state.branchId);
        pushState();
        log("RabbitMQ broker host not configured — set connection in Settings when ready.", "ℹ️");
        return;
      }
      if (!String(rabbitOpts.exchange || "").trim()) {
        state.rabbitmq = "idle";
        pushState();
        log("RabbitMQ exchange not set — set Exchange in Settings.", "ℹ️");
        return;
      }
      log(
        "Agent API base URL not set — configure it in Settings to claim print host. Rabbit stays idle.",
        "ℹ️"
      );
      state.rabbitmq = "idle";
      pushState();
      return;
    }

    state.rabbitmq = "connecting";
    state.channel = resolveRoutingKey(getRoutingKeyTemplate(), state.branchId);
    pushState();
    rabbitStarting = true;

    try {
      // Resume via heartbeat when token exists; otherwise register (pairing required).
      let sp;
      const cfg0 = readUserConfig();
      const apiConfigured = Boolean(cfg0.agent_api_base && String(cfg0.agent_api_base).trim());
      if (apiConfigured) {
        try {
          sp = getStationPrinting();
          const sess = await sp.ensureSession({ branchId: state.branchId });
          if (sess && sess.needsPairing) {
            state.rabbitmq = "idle";
            log(
              "Agent token missing or revoked — enter a fresh pairing code in Settings → Print host, then Save & register.",
              "⚠️"
            );
            pushState();
            return;
          }
          if (sess && sess.pairingError) {
            state.rabbitmq = "idle";
            log(`Register blocked: ${sess.pairingError.message}`, "⚠️");
            pushState();
            return;
          }
          if (sess && sess.conflict) {
            state.rabbitmq = "idle";
            log(
              "RabbitMQ consumer idle — another device is print host (or this is a reinstall with a new app_id). Ask admin to Change print host in Settings → Printing → Print devices to this device, then Retry.",
              "⚠️"
            );
            pushState();
            return;
          }
          if (sess && !sess.ok) {
            state.rabbitmq = "idle";
            const errMsg =
              (sess.error && `${sess.error.code || ""} ${sess.error.message || ""}`.trim()) ||
              "Session failed";
            log(`Print-agent session failed: ${errMsg} — Rabbit stays idle.`, "⚠️");
            pushState();
            return;
          }
          if (sess && sess.resumed) {
            log("Resumed print-host session via heartbeat (no re-register).", "✅");
            if (sess.flushPending || (sess.pending_job_count > 0)) {
              log(
                "Held jobs may arrive with delayed=true after reconnect — server flush on heartbeat.",
                "⏱️"
              );
            }
          }
          if (!sp.shouldConsume()) {
            state.rabbitmq = "idle";
            log(
              "Not the print host for this branch — Rabbit consumer stays idle (HostOnlyPolicy).",
              "ℹ️"
            );
            pushState();
            startAgentHeartbeatLoop();
            return;
          }
        } catch (regErr) {
          log(
            "Print-agent session skipped/failed: " +
              (regErr.message || String(regErr)) +
              " — will not consume until host is confirmed.",
            "⚠️"
          );
          state.rabbitmq = "idle";
          pushState();
          return;
        }
      }

      // Sync Branch ID from register/heartbeat (server is source of truth on fresh Connect).
      // H1 r10: never await applyBranchId here — it would re-enter rabbitStartChain and deadlock.
      {
        const cfgBranch = readUserConfig();
        const serverBranch =
          cfgBranch.branch_id != null ? String(cfgBranch.branch_id).trim() : "";
        const synced = syncBranchIdFromServer(state, serverBranch, {
          resolveRoutingKey,
          getRoutingKeyTemplate,
          saveUserConfig,
        });
        if (synced.changed) {
          log(
            `Branch ID set to ${synced.branchId} — listening on ${synced.channel || "(set routing key)"}`,
            "📌"
          );
          pushState();
        }
      }
      if (!String(state.branchId || "").trim()) {
        state.rabbitmq = "idle";
        pushState();
        log(
          "No Branch ID after register — server did not return branch_id; cannot consume yet.",
          "⚠️"
        );
        return;
      }

      // Rebuild broker options after register may have applied rabbit.* creds
      rabbitOpts = buildRabbitOptions();
      if (!rabbitOpts.configured || !String(rabbitOpts.exchange || "").trim()) {
        state.rabbitmq = "idle";
        pushState();
        log("RabbitMQ not configured after register — set connection in Settings.", "ℹ️");
        return;
      }
      const routed = getRoutingForBranch(state.branchId);
      const liveRoutingKey = routed.routingKey;
      const liveQueueName = routed.queueName;
      boundForThisStart = String(state.branchId || "").trim();
      if (!liveRoutingKey || !liveQueueName) {
        state.rabbitmq = "idle";
        state.channel = liveRoutingKey || "";
        pushState();
        log("Routing key / queue not set after register.", "ℹ️");
        return;
      }
      state.channel = liveRoutingKey;

      // Declare/bind on a throwaway connection first so a 406 cannot poison consume.
      await ensureHostPrintQueue(
        liveQueueName,
        rabbitOpts.exchange,
        liveRoutingKey,
        state.branchId
      );

      const connection = await amqp.connect(rabbitOpts.url, {
        timeout: RABBIT_CONNECT_TIMEOUT_MS,
      });
      rabbitConnection = connection;
      connection.on("error", (err) => {
        if (connection !== rabbitConnection || rabbitStarting) return;
        log("RabbitMQ connection error: " + err.message, "❌");
        scheduleRabbitReconnect();
      });
      connection.on("close", () => {
        if (connection !== rabbitConnection || app.isQuiting || rabbitStarting) return;
        log("RabbitMQ disconnected — restarting...", "⚠️");
        scheduleRabbitReconnect();
      });

      const channel = await connection.createChannel();
      rabbitChannel = channel;

      const prefetchN =
        getStationPrinting().rabbitPrefetch
          ? getStationPrinting().rabbitPrefetch()
          : 1;
      await channel.prefetch(prefetchN);
      const exchangeType = rabbitOpts.exchangeType || "topic";
      try {
        await channel.assertExchange(rabbitOpts.exchange, exchangeType, { durable: true });
      } catch (exErr) {
        if (!isInequivalentArgError(exErr)) throw exErr;
        // Exchange already exists with different args — continue and bind only.
        rabbitChannel = null;
        const nextCh = await connection.createChannel();
        rabbitChannel = nextCh;
        await nextCh.prefetch(prefetchN);
      }
      const liveChannel = rabbitChannel;
      await liveChannel.checkQueue(liveQueueName);
      const bound = await bindBranchQueue(
        liveChannel,
        liveQueueName,
        rabbitOpts.exchange,
        liveRoutingKey,
        state.branchId
      );
      wireRabbitChannel(liveChannel);

      // Contract: exclusive=false; prefetch from register (default 1). SAC is on the queue declare.
      const consumeOpts = getStationPrinting().rabbitConsumeOptions
        ? getStationPrinting().rabbitConsumeOptions()
        : { exclusive: false, noAck: false };
      const consumed = await liveChannel.consume(liveQueueName, async (msg) => {
        if (!msg) {
          if (liveChannel === rabbitChannel && !app.isQuiting) {
            log("RabbitMQ consumer cancelled by broker — reconnecting...", "⚠️");
            scheduleRabbitReconnect();
          }
          return;
        }
        const message = msg.content ? msg.content.toString("utf8") : "";
        const outcome = await handleMessage(liveRoutingKey, message);
        if (liveChannel !== rabbitChannel) return;
        try {
          if (outcome === "ack") liveChannel.ack(msg);
          else if (outcome === "reject") liveChannel.nack(msg, false, false);
          else liveChannel.nack(msg, false, true);
        } catch (_) {
          // Channel may close between message handling and ack/nack.
        }
      }, consumeOpts);
      rabbitConsumerTag = consumed.consumerTag;

      let queueInfo = { messageCount: "?", consumerCount: "?" };
      try {
        queueInfo = await liveChannel.checkQueue(liveQueueName);
      } catch (_) {}

      state.rabbitmq = "connected";
      resetRabbitReconnectBackoff();
      lastKnownOnline = true;
      ensureRabbitHealthCheck();
      log("RabbitMQ connected.", "✅");
      log(
        `Consuming ${liveQueueName} as print host (${queueInfo.messageCount} ready, ${queueInfo.consumerCount} consumers). Bindings: ${bound.join("; ") || "(none)"}`,
        "📡"
      );
      startAgentHeartbeatLoop();
      // N2: flush durable server-ack outbox after reconnect
      scheduleAckOutboxFlush(0);
      try {
        const sp2 = getStationPrinting();
        if (sp2.flushPending) {
          log(
            "Print host online — server will flush queued jobs with Delayed marker (pending_job_count from heartbeat).",
            "⏱️"
          );
          // Server publishes Delayed jobs on host heartbeat; local flag cleared after HB confirms.
        }
        // L2 parity: force printers/sync on Rabbit connect (clear hash).
        try { saveUserConfig({ last_printer_list_sync_hash: "" }); } catch (_) {}
        await sp2.syncPrintersToServer({ branchId: state.branchId, force: true });
      } catch (_) {}
      pushState();
    } catch (err) {
      state.rabbitmq = "error";
      {
        const msg = err && err.message ? String(err.message) : String(err);
        const refused =
          /ECONNREFUSED/i.test(msg) ||
          (err && (err.code === "ECONNREFUSED" || err.errno === "ECONNREFUSED"));
        const guestHint = refused
          ? " If the broker user is guest, RabbitMQ only allows that from localhost."
          : "";
        log("RabbitMQ start failed: " + msg + guestHint, "❌");
      }
      pushState();
      scheduleRabbitReconnect();
    } finally {
      rabbitStarting = false;
      // r11 M1: if applyBranchId skipped reconnect (or branch changed after bind capture),
      // queue an outer startRabbit — never await here (would re-enter the chain).
      const desired = String(state.branchId || "").trim();
      if (
        shouldFlushPendingBranchReconnect({
          pending: pendingBranchReconnect,
          desiredBranch: desired,
          boundBranch: boundForThisStart,
        })
      ) {
        pendingBranchReconnect = false;
        queueMicrotask(() => {
          startRabbit().catch((err) =>
            log(
              "Pending branch reconnect failed: " +
                (err && err.message ? err.message : String(err)),
              "❌"
            )
          );
        });
      }
    }
  };

  const next = rabbitStartChain.then(run, run);
  rabbitStartChain = next.catch(() => {});
  return next;
}

/** Order id from broker JSON — snake_case or camelCase. */
function _extractOrderIdFromPayload(data) {
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
function _extractFilePathFromPayload(data) {
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

/** Inline PDF from broker — prefer over downloading file_path when present. */
function _extractPdfBase64FromPayload(data) {
  if (!data || typeof data !== "object") return "";
  const raw =
    data.pdf_base64 ??
    data.pdfBase64 ??
    data.file_base64 ??
    data.fileBase64 ??
    data.base64_pdf ??
    data.base64Pdf ??
    "";
  if (raw == null) return "";
  const s = typeof raw === "string" ? raw.trim() : String(raw).trim();
  return s;
}

async function applyBranchId(id) {
  state.branchId = id;
  state.channel = resolveRoutingKey(getRoutingKeyTemplate(), id);
  saveUserConfig({ branch_id: id });
  // R5D-L3: a branch change unblocks auto-register so a BRANCH_MISMATCH user
  // who fixed the branch does not also have to tap Retry.
  try {
    const sp = getStationPrinting();
    if (sp && typeof sp.allowManualRegister === "function") sp.allowManualRegister();
  } catch (_) {}
  log(`Branch ID set to ${id} — listening on ${state.channel || "(set routing key)"}`, "📌");
  pushState();
  // Nested call from startRabbit (or race while rabbitStarting): state already synced;
  // do not await startRabbit — that re-enters rabbitStartChain and deadlocks (r10 H1).
  if (!shouldReconnectAfterBranchApply(rabbitStarting)) {
    pendingBranchReconnect = true;
    return { ok: true, skippedReconnect: true };
  }
  resetRabbitReconnectBackoff();
  await startRabbit();
  await pollPrinters();
  return { ok: true };
}

async function handleMessage(channel, message) {
  log(`New order on ${channel}`, "📩");

  try {
    const sp = getStationPrinting();
    const evaluated = sp.evaluateIncomingMessage(message);
    if (evaluated.action === "nack") {
      log(
        `Skipping message (${evaluated.reason || "policy"}) — nack without requeue.`,
        "⚠️"
      );
      return "reject"; // reject = nack no-requeue in consume handler
    }
    if (evaluated.action !== "print" || !evaluated.parsed) {
      log("Rejecting unprintable message: " + (evaluated.reason || "unknown"), "❌");
      return "reject";
    }

    const parsed = evaluated.parsed;
    const orderId = parsed.order_id;
    const serverJobId = parsed.job_id;
    // M3: local dedupe — redelivered job_id already printed/failed → Rabbit ack only
    if (serverJobId && getProcessedJobs().has(serverJobId)) {
      log(
        `job_id=${serverJobId} already processed locally — acking Rabbit without reprint.`,
        "✅"
      );
      scheduleAckOutboxFlush(0);
      return "ack";
    }
    // Crash window: printing marker set but not processed → do not auto-print again.
    // Fail-ack PRINT_INTERRUPTED so staff can reprint from Print jobs.
    if (serverJobId && getProcessedJobs().isPrinting(serverJobId)) {
      const printerExternalIdEarly =
        (evaluated.route &&
          evaluated.route.printer &&
          evaluated.route.printer.external_id) ||
        parsed.printer_external_id ||
        null;
      log(
        `job_id=${serverJobId} has durable printing marker (interrupted) — fail-ack PRINT_INTERRUPTED, no reprint.`,
        "⚠️"
      );
      finalizeServerAck({
        serverJobId,
        status: "failed",
        reason: STATION_ERROR_CODES.PRINT_INTERRUPTED || "PRINT_INTERRUPTED",
        printerExternalId: printerExternalIdEarly,
      });
      return "ack";
    }
    state.lastOrder = {
      timestamp: new Date().toISOString(),
      channel,
      orderId,
    };
    pushState();

    // Prefer pdf_base64; fall back to signed pdf_url; then legacy file_path.
    const pdfUrl = parsed.pdf_url || "";
    const pdfBase64 = parsed.pdf_base64 || "";
    const filePath = parsed.file_path || "";
    const remoteUrl =
      pdfUrl ||
      (filePath.startsWith("http://") || filePath.startsWith("https://") ? filePath : "");
    const localFilePath =
      !remoteUrl && filePath && !filePath.startsWith("http") ? filePath : "";
    if (!pdfUrl && !pdfBase64 && !filePath) {
      log("Missing pdf_base64 / pdf_url / file_path in message.", "❌");
      if (serverJobId) {
        finalizeServerAck({
          serverJobId,
          status: "failed",
          reason: STATION_ERROR_CODES.MISSING_PDF || "MISSING_PDF",
        });
      }
      return "ack";
    }

    const route = evaluated.route;
    const printerExternalId =
      (route && route.printer && route.printer.external_id) ||
      parsed.printer_external_id ||
      null;
    const printerName =
      (route && route.printer && (route.printer.windows_name || route.printer.name)) ||
      state.defaultPrinter;
    if (!printerName) {
      log("No printer available for this job.", "❌");
      if (serverJobId) {
        finalizeServerAck({
          serverJobId,
          status: "failed",
          reason: "no_printer",
          printerExternalId,
        });
      }
      return "ack";
    }

    const jobId = crypto.randomBytes(8).toString("hex");
    const store = getJobsStore();
    const preferredName = remoteUrl
      ? derivePdfBasename(remoteUrl, true)
      : localFilePath
        ? derivePdfBasename(localFilePath, false)
        : `order-${Date.now()}.pdf`;

    let localPath;
    let saveSource = null;
    try {
      // Prefer pdf_base64; fall back to pdf_url / file_path with a clear log.
      if (pdfBase64) {
        try {
          localPath = await saveIncomingPdfFromBase64(store, jobId, pdfBase64, preferredName);
          saveSource = "pdf_base64";
        } catch (b64Err) {
          if (b64Err && b64Err.code === "PDF_TOO_LARGE") {
            // Still allow URL fallback for oversized inline payloads.
          }
          if (!remoteUrl && !localFilePath) throw b64Err;
          const reason = (b64Err && b64Err.message) || String(b64Err);
          if (remoteUrl) {
            log(
              `pdf_base64 failed (${reason}) — falling back to pdf_url.`,
              "⚠️"
            );
            const bearer =
              (getStationPrinting().api && getStationPrinting().api.getToken()) ||
              readUserConfig().agent_token ||
              "";
            localPath = await saveIncomingPdf(store, jobId, remoteUrl, true, {
              authToken: bearer,
            });
            saveSource = pdfUrl ? "pdf_url" : "file_path_url";
          } else {
            log(
              `pdf_base64 failed (${reason}) — falling back to file_path.`,
              "⚠️"
            );
            localPath = await saveIncomingPdf(store, jobId, localFilePath, false);
            saveSource = "file_path";
          }
        }
      } else if (remoteUrl) {
        const bearer =
          (getStationPrinting().api && getStationPrinting().api.getToken()) ||
          readUserConfig().agent_token ||
          "";
        localPath = await saveIncomingPdf(store, jobId, remoteUrl, true, {
          authToken: bearer,
        });
        saveSource = pdfUrl ? "pdf_url" : "file_path_url";
      } else {
        localPath = await saveIncomingPdf(store, jobId, localFilePath, false);
        saveSource = "file_path";
      }
      // Contract: pdf_sha256 mismatch → ack failed PDF_CHECKSUM_MISMATCH; do not print
      if (parsed.pdf_sha256 && localPath) {
        const buf = fs.readFileSync(localPath);
        const check = verifyPdfChecksum(buf, parsed.pdf_sha256);
        if (!check.ok) {
          const reason = check.reason || "PDF_CHECKSUM_MISMATCH";
          log(
            `pdf_sha256 mismatch (got ${(check.digest || "").slice(0, 12)}… expected ${String(parsed.pdf_sha256).slice(0, 12)}…) — ack failed, not printing.`,
            "❌"
          );
          store.upsert({
            id: jobId,
            file: preferredName,
            orderId,
            serverJobId,
            printerName,
            printerExternalId,
            delayed: !!parsed.delayed,
            ticketType: parsed.ticket_type,
            status: "failed-setup",
            attemptNumber: 0,
            nextRetryAt: null,
            lastError: reason,
            channel,
            localPath,
          });
          syncJobsToState();
          pushState();
          if (serverJobId) {
            finalizeServerAck({
              serverJobId,
              status: "failed",
              reason,
              printerExternalId,
            });
          }
          return "ack";
        }
      }
    } catch (err) {
      const failReason =
        err && err.code === "PDF_URL_EXPIRED"
          ? "PDF_URL_EXPIRED"
          : err && err.code === "PDF_TOO_LARGE"
            ? "PDF_TOO_LARGE"
            : err && err.code === "PDF_HOST_NOT_ALLOWED"
              ? "PDF_HOST_NOT_ALLOWED"
              : err && err.code === (STATION_ERROR_CODES.INVALID_PDF || "INVALID_PDF")
                ? STATION_ERROR_CODES.INVALID_PDF || "INVALID_PDF"
                : err && err.code === (STATION_ERROR_CODES.MISSING_PDF || "MISSING_PDF")
                  ? STATION_ERROR_CODES.MISSING_PDF || "MISSING_PDF"
                  : err.message || "save_failed";
      log("Could not save PDF: " + failReason, "❌");
      store.upsert({
        id: jobId,
        file: preferredName,
        orderId,
        serverJobId,
        printerName,
        printerExternalId,
        delayed: !!parsed.delayed,
        ticketType: parsed.ticket_type,
        status: "failed-setup",
        attemptNumber: 0,
        nextRetryAt: null,
        lastError: failReason,
        channel,
        localPath: "",
      });
      syncJobsToState();
      pushState();
      if (serverJobId) {
        finalizeServerAck({
          serverJobId,
          status: "failed",
          reason: failReason,
          printerExternalId,
        });
      }
      return "ack";
    }

    const baseFile = path.basename(localPath);
    store.upsert({
      id: jobId,
      file: baseFile,
      orderId,
      serverJobId,
      printerName,
      printerExternalId: route && route.printer ? route.printer.external_id : null,
      delayed: !!parsed.delayed,
      ticketType: parsed.ticket_type,
      status: "in-queue",
      attemptNumber: 0,
      nextRetryAt: null,
      lastError: null,
      channel,
      localPath,
    });
    syncJobsToState();
    pushState();
    const delayNote = parsed.delayed ? " [Delayed]" : "";
    // Server PDF already renders the Delayed banner — log + job-log UI only (no overlay).
    log(`Saved job PDF via ${saveSource}: ${baseFile} → ${printerName}${delayNote}`, "📁");
    if (parsed.delayed) {
      log(
        `Delayed job ${serverJobId || jobId} — indicator shown in job log (server PDF includes Delayed banner; no local overlay).`,
        "⏱️"
      );
    }

    // Persist printing marker BEFORE spooling so a crash cannot double-print on redelivery.
    if (serverJobId) {
      getProcessedJobs().markPrinting(serverJobId);
    }
    // N2: print; mark processed + durable outbox inside finalizeServerAck;
    // Rabbit ack only after outbox entry is written (never reprint on redelivery).
    await runPrintAttempt(jobId);
    if (serverJobId && !getProcessedJobs().has(serverJobId)) {
      // Safety: print path without server ack (shouldn't happen) — still mark
      getProcessedJobs().mark(serverJobId);
    }
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
const POWER_SESSION_REFRESH_DEBOUNCE_MS = 2000;
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
    resetRabbitReconnectBackoff();
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
    setupNetworkOnlineMonitor();

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
    try {
      const cfg0 = readUserConfig();
      if (cfg0.secrets_encryption_unavailable) {
        log(
          "Secure storage unavailable — agent token / Rabbit password are session-only and will not survive restart. Re-pair after restart.",
          "⚠️"
        );
      }
    } catch (_) {}
    if (state.branchId) {
      log(`Branch ID: ${state.branchId} — listening on ${state.channel || "(set routing key)"}`, "📌");
    } else {
      log("Branch ID not set — configure Branch and RabbitMQ in Settings.", "📌");
    }
    await startRabbit();
    // N2: flush any pending server acks left from prior session
    scheduleAckOutboxFlush(0);
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
    clearNetworkOnlineMonitor();
    stopAgentHeartbeatLoop();
    try {
      await getStationPrinting().deregister();
    } catch (_) {}
    await stopRabbit();
  });
}