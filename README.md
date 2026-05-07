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
  - Maintenance: restart agent, open logs folder, open print-jobs folder, and in-app **View logs** modal.

---

## Storage Paths

Under `%APPDATA%/tawla-print-agent/`:

- `config.json`
- `logs/` (daily log files; retention cleanup applies)
- `print-jobs/incoming/`
- `print-jobs/dlq/`
- `print-jobs/jobs.json`

---

## Notes

- Printing and spooler tracking are Windows-oriented (`pdf-to-printer` + PowerShell `Get-PrintJob`).
- If spooler tracking is unavailable, print submission is still considered sent and logged accordingly.
