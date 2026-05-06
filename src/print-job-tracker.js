const path = require("path");
const { promisify } = require("util");
const { execFile } = require("child_process");

const execFileAsync = promisify(execFile);

const JOB_ERROR = 2;
const JOB_DELETING = 4;
const JOB_SPOOLING = 8;
const JOB_PRINTING = 16;
const JOB_RETAINED = 128;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function jobStatusLabel(flags) {
  const f = Number(flags) || 0;
  const parts = [];
  if (f & JOB_SPOOLING) parts.push("spooling");
  if (f & JOB_PRINTING) parts.push("printing");
  if (f & JOB_ERROR) parts.push("error");
  if (f & JOB_DELETING) parts.push("deleting");
  if (f & JOB_RETAINED) parts.push("retained");
  if (!parts.length) parts.push("queued");
  return parts.join(", ");
}

async function queryWindowsPrintJobs(printerName) {
  const payload = Buffer.from(JSON.stringify({ p: printerName }), "utf8").toString("base64");
  const script =
    "$ErrorActionPreference='SilentlyContinue';" +
    `$d=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'))|ConvertFrom-Json;` +
    "$jobs=@(Get-PrintJob -PrinterName $d.p);" +
    "$out=@($jobs|ForEach-Object { @{" +
    "Id=$_.Id;" +
    "JobStatus=[int]$_.JobStatus;" +
    "DocumentName=[string]$_.DocumentName;" +
    "SubmittedTime=if($_.SubmittedTime){$_.SubmittedTime.ToString('o')}else{''}" +
    "}})" +
    ";" +
    "if($out.Count -eq 0){'[]'}else{$out|ConvertTo-Json -Compress}";

  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
    { windowsHide: true, maxBuffer: 2 * 1024 * 1024, timeout: 15000 }
  );
  const trimmed = (stdout || "").trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed;
    return parsed ? [parsed] : [];
  } catch {
    return [];
  }
}

function pickMatchingJob(jobs, tmpPath, printStartedAt) {
  if (!jobs || !jobs.length) return null;
  const marker = path.basename(tmpPath).toLowerCase();
  const norm = path.resolve(tmpPath).replace(/\//g, "\\").toLowerCase();
  const early = printStartedAt - 20000;
  const late = Date.now() + 10000;

  const scored = jobs
    .map((j) => {
      const doc = String(j.DocumentName || "").toLowerCase();
      const byName = doc.includes(marker) || doc.includes(norm);
      let t = 0;
      if (j.SubmittedTime) {
        t = new Date(j.SubmittedTime).getTime();
        if (t < early || t > late) return { j, score: -1 };
      }
      let score = byName ? 100 : 0;
      if (byName && t) score += Math.min(50, Math.max(0, 50 - (t - printStartedAt) / 1000));
      return { j, score };
    })
    .filter((x) => x.score >= 0)
    .sort((a, b) => b.score - a.score);

  return scored.length && scored[0].score > 0 ? scored[0].j : null;
}

/**
 * After Sumatra hands off to the spooler, poll Windows until the job leaves the queue
 * or errors. This reflects the print *spooler*, not guaranteed paper out.
 *
 * @param {{ printerName: string, tmpPath: string, printStartedAt: number, log: (m: string, i?: string) => void }} opts
 * @returns {Promise<'finished'|'error'|'untracked'|'timeout'>}
 */
async function watchWindowsPrintJob(opts) {
  const { printerName, tmpPath, printStartedAt, log } = opts;
  const findTimeoutMs = 20000;
  const totalDeadlineMs = 180000;
  const pollMs = 450;

  await sleep(300);

  const findUntil = Date.now() + findTimeoutMs;
  const hardUntil = Date.now() + totalDeadlineMs;

  let seen = null;
  let lastLabel = null;

  while (Date.now() < findUntil) {
    let jobs;
    try {
      jobs = await queryWindowsPrintJobs(printerName);
    } catch (err) {
      log(`Print queue status unavailable (${err.message}) — job was still submitted.`, "⚠️");
      return "untracked";
    }
    seen = pickMatchingJob(jobs, tmpPath, printStartedAt);
    if (seen) break;
    await sleep(pollMs);
  }

  if (!seen) {
    log(
      `Could not match this job in the Windows print queue (document name may differ).`,
      "⚠️"
    );
    return "untracked";
  }

  log(`Print job in queue on "${printerName}" (${jobStatusLabel(seen.JobStatus)})`, "🖨️");
  lastLabel = jobStatusLabel(seen.JobStatus);

  while (Date.now() < hardUntil) {
    let jobs;
    try {
      jobs = await queryWindowsPrintJobs(printerName);
    } catch {
      await sleep(pollMs);
      continue;
    }
    const still = jobs.find((j) => j.Id === seen.Id);

    if (!still) {
      log(`Print job finished (left spooler) on "${printerName}"`, "✅");
      return "finished";
    }

    if (still.JobStatus & JOB_ERROR) {
      log(`Print job error in spooler on "${printerName}" (${jobStatusLabel(still.JobStatus)})`, "❌");
      return "error";
    }

    const label = jobStatusLabel(still.JobStatus);
    if (label !== lastLabel) {
      log(`Print job on "${printerName}": ${label}`, "🖨️");
      lastLabel = label;
    }

    await sleep(pollMs);
  }

  log(`Stopped tracking print job (timeout) on "${printerName}" — check the printer.`, "⚠️");
  return "timeout";
}

module.exports = { watchWindowsPrintJob };
