# Tawla Print Agent

Windows desktop app that runs in the **system tray**, connects to **Tawla’s print queue** over the network, and sends incoming **PDF receipts** to your chosen printer automatically.

---

## Download & install (for venues / IT)

### Where to get it

1. On GitHub, open this repository and go to **Releases**, or use the **direct link** your vendor sent you (it ends with `/releases`).
2. Under **Assets**, download the latest **Windows installer** — the file name looks like **`Tawla Print Agent Setup x.y.z.exe`** (not the source code zip).
3. Run the installer and complete the steps. Installation may require **administrator approval** (machine-wide install).
4. When setup finishes, the app can start automatically; otherwise open **Tawla Print Agent** from the **Start menu**.

After install, look for the **tray icon** (near the clock). **Double‑click** it or use **Open Dashboard** from the menu to open the settings window.

### Before you install — checklist

| Requirement | Notes |
|-------------|--------|
| **Windows PC** | Printing is supported on **Windows** only (64‑bit). |
| **Printer installed** | Install your receipt printer in Windows and confirm a test page prints. |
| **Internet / network** | The PC must reach your **RabbitMQ** server (host/port/firewall as provided by Tawla). |
| **Credentials** | Your onboarding should include **Branch ID** and **RabbitMQ** settings (host, port, username, password, exchange). If an installer or IT script already set the branch ID, you may only need to confirm printer and connection in the app. |

### First-time setup in the app

1. **Settings → Branch ID** — must match your venue (from Tawla).  
2. **Settings → RabbitMQ** — enter host, port, username, password, and exchange if not already configured.  
3. **Settings → Default printer** — pick the receipt printer.  
4. Optional: **PDF scaling & paper** — if output is clipped or the wrong size, adjust scale / paper name with guidance from support.  
5. **Maintenance** — log and job retention defaults are usually fine; increase **job file** retention only if you need longer history on disk.

When RabbitMQ shows **connected**, new orders should appear under **Queue** and print according to your workflow.

### Everyday use

- The agent keeps running in the **tray** after you close the window (close hides to tray; use **Quit** from the tray menu to exit fully).
- Use **Queue** to see status, open a PDF preview (job name), **Retry** failed jobs, or **Resend** completed ones when needed.
- If the PC sleeps or the network drops, the app **reconnects** automatically as soon as the link (and broker) are reachable again; after **wake from sleep** or **unlocking** the screen it refreshes connection and printers.

### Disk space & notifications

If Windows disk space runs low, you may get a **notification** and see a message in the dashboard. The app can remove **old logs** and **old completed queue files** according to your retention settings. **Free disk space** if you see warnings — critical lack of space can prevent saving new PDFs.

### Problems?

- Confirm **default printer** is correct and the printer is **Ready** in Windows.  
- Confirm **RabbitMQ** fields match what Tawla provided and firewalls allow the port.  
- Use tray → **Restart Agent**, then contact support with the **log** text (**Maintenance → View logs**) if issues continue.

---

## Technical overview (operators & support)

- **Transport**: RabbitMQ — exchange and routing key are configured in Settings (routing key may use `{branch_id}`, e.g. `orders.{branch_id}`). Queue name is `printer.Branch.<branch_id>`. The shared queue uses **single active consumer** so desktop and Android (or two PCs) can both stay connected while only one agent receives each order; the standby takes over if the active one disconnects. If an older queue exists without that flag, the agent recreates it once on connect. Order payloads may include inline `pdf_base64` (preferred) and/or `file_path` / URL; the agent uses base64 first and falls back to downloading `file_path` if base64 is missing or invalid.
- **First install**: Branch ID and RabbitMQ fields start empty (no silent prefills). Configure them in Settings before the agent will consume.
- **Reconnect**: Automatic on broker/network issues, consumer cancellation, and failed health checks. While disconnected, the agent polls OS online state and probes the broker host so it reconnects **as soon as the network (or broker) is reachable again**, instead of waiting out a long backoff. Backoff starts at ~1s (cap 15s online / 30s offline). Health checks run every 5s; connect timeout is 10s.
- **Sleep / lock**: Debounced refresh after **resume** or **screen unlock** so RabbitMQ and printer lists recover.
- **Retries**: Up to several attempts per job with backoff; persistent failures go to **dead letter** in the UI.
- **Poison messages**: Bad/missing PDF payloads are not requeued infinitely.
- **Storage** (under `%APPDATA%\tawla-print-agent\`): `config.json`, `logs\`, `print-jobs\` (incoming, dlq, `jobs.json`). Separate retention for **logs** vs **job files** (defaults **7** / **1** days).

---

## For developers

### Project layout

```
Auto Printing/
├── index.html
├── src/
│   ├── main.js
│   ├── preload.js
│   ├── print-job-tracker.js
│   └── print-jobs-store.js
├── assets/
└── package.json
```

### Dev & build

```bash
npm install
npm start          # development
npm run dist       # Windows zip → dist/ (works on Apple Silicon)
npm run dist:nsis  # Windows NSIS Setup.exe (needs Rosetta on Apple Silicon, or a Windows PC)
```

Printing and spooler tracking target **Windows** (`pdf-to-printer` + PowerShell).

**Building on Apple Silicon:** electron-builder’s Wine/`rcedit` and NSIS `makensis` are Intel binaries. This project sets `signAndEditExecutable: false` so packaging does not need Wine. `npm run dist` produces a **zip** (no `makensis`). For the classic **Setup.exe**, either:

1. Install Rosetta, then run `npm run dist:nsis`:
   ```bash
   softwareupdate --install-rosetta --agree-to-license
   npm run dist:nsis
   ```
2. Or build on a Windows machine / CI Windows runner.
