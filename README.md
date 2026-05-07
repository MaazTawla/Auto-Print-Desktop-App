# Tawla Print Agent

Windows system-tray Electron app that consumes print orders from RabbitMQ and prints PDFs to a selected local printer.

---

## Project Structure

```
Auto Printing/
├── index.html                 # Dashboard UI
├── src/
│   ├── main.js                # Electron main process (RabbitMQ, printing, tray, IPC)
│   ├── preload.js             # Secure renderer ↔ main bridge
│   ├── print-job-tracker.js   # Windows spooler job tracking
│   └── print-jobs-store.js    # Persistent jobs manifest + incoming/dlq folders
├── assets/
│   ├── icon.png
│   └── icon.ico
└── package.json
```

---

## Setup

```bash
npm install
```

---

## Run (Dev)

```bash
npm start
```

The app starts in tray mode and can be opened from the tray icon.

---

## Build Installer

```bash
npm run dist
```

This builds the Windows NSIS installer in `dist/`.

---

## Runtime Behavior

- **RabbitMQ transport**: listens on exchange `orders.print` with routing key `branch.<branch_id>`, queue `printer.Branch.<branch_id>`.
- **Auto reconnect**: reconnects after connection/channel errors, broker disconnects, broker consumer cancellation, and periodic health-check failures.
- **Sleep / lock**: on **resume from sleep** or **screen unlock** (manual lock, idle lock, or returning after sleep), the app runs a debounced refresh (`restartSystem`) so RabbitMQ and printer state recover without sitting in a broken state. Screen lock alone does not stop the tray agent; connection usually stays up until suspend or network loss.
- **Disk space**: periodic checks (every ~5 minutes) with **low** / **critical** thresholds; **Windows toast** (tray) + **in-app banner** when space is low. On **critical** or **ENOSPC**, the app removes log / job data **older than your retention setting**, runs the normal print-job cleanup, and may **trim oldest completed / DLQ / failed / retry-scheduled** rows from `jobs.json` and delete their files. Incoming PDF save also runs a space check first.
- **Log files**: under `logs/`, **date-named** `YYYY-MM-DD.log` files; retention is **Settings → Maintenance → Delete logs older than (days)** (default **7**, range **1–365**). Clean-up runs on an hourly timer, every ~5 minutes with disk checks, on save, and during disk pressure.
- **Print-job files**: retention is **Delete queue / job files older than (days)** (default **1** day, range **1–365**). Same cleanup schedule as logs.
- **Queue UI**: filter jobs by **status** (all, queued, printing, retry scheduled, completed, dead letter, failed setup).
- **Broker heartbeat**: uses AMQP heartbeat to detect dead connections faster.
- **Poison message protection**: invalid or missing local file payloads are rejected without requeue (prevents infinite replay loop).
- **Print retries**: per job, 3 retry delays (`5s`, `30s`, `60s`) after initial attempt, then job moves to DLQ.
- **Scheduled self-restart**: app restarts its runtime loop every 1.5 hours.
- **PDF scaling**: Windows printing uses `pdf-to-printer` (SumatraPDF). Configure **Settings → PDF scaling & paper** for `fit` / `shrink` / `noscale` and an optional `paperSize` string when the server PDF page size does not match the receipt printer’s logical page. Full Windows driver “preferences” are not read programmatically; matching paper names come from the driver when exposed via `getPrinters()`.

---

## Dashboard / Settings Highlights

- **Home**: connection state, routing key, last order, last printed job, jobs count.
- **Queue**: print jobs list with status, attempts, next retry, errors, and actions.
- **Settings**:
  - Branch ID
  - RabbitMQ host/port/user/password/exchange
  - Default printer
  - PDF scaling & optional paper size (saved in `config.json` as `print_scale`, `print_paper_size`)
  - Startup + crash-restart behavior
  - Appearance (light/dark)
  - Maintenance: separate retention for **logs** vs **queue/job files** (defaults **7** / **1** days), restart agent, open folders, in-app **View logs**.

---

## Storage Paths

Under `%APPDATA%/tawla-print-agent/`:

- `config.json` (includes `log_retention_days`, `job_retention_days`; legacy `retention_days` is read for logs only until you save new settings)
- `logs/` (daily log files; retention cleanup applies)
- `print-jobs/incoming/`
- `print-jobs/dlq/`
- `print-jobs/jobs.json`

---

## Notes

- Printing and spooler tracking are Windows-oriented (`pdf-to-printer` + PowerShell `Get-PrintJob`).
- If spooler tracking is unavailable, print submission is still considered sent and logged accordingly.
