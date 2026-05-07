const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  getState: () => ipcRenderer.invoke("get-state"),
  openLogsDir: () => ipcRenderer.invoke("open-logs-dir"),
  openPrintJobsDir: () => ipcRenderer.invoke("open-print-jobs-dir"),
  openJobPdfExternal: (jobId) => ipcRenderer.invoke("open-job-pdf-external", jobId),
  restartSystem: () => ipcRenderer.invoke("restart-system"),
  setBranchId: (id) => ipcRenderer.invoke("set-branch-id", id),
  setDefaultPrinter: (name) => ipcRenderer.invoke("set-default-printer", name),
  setStartupSettings: (opts) => ipcRenderer.invoke("set-startup-settings", opts),
  setDarkMode: (enabled) => ipcRenderer.invoke("set-dark-mode", enabled),
  setPrintLayout: (opts) => ipcRenderer.invoke("set-print-layout", opts),
  setRetentionSettings: (opts) => ipcRenderer.invoke("set-retention-settings", opts),
  setRabbitSettings: (opts) => ipcRenderer.invoke("set-rabbit-settings", opts),
  retryPrintJob: (id) => ipcRenderer.invoke("retry-print-job", id),
  resendPrintJob: (id) => ipcRenderer.invoke("resend-print-job", id),
  testPrint: () => ipcRenderer.invoke("test-print"),
  onStateUpdate: (cb) => ipcRenderer.on("state-update", (_event, state) => cb(state)),
  minimize: () => ipcRenderer.send("window-minimize"),
  close: () => ipcRenderer.send("window-close"),
});
