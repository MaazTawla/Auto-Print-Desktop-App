/**
 * Scan the local IPv4 subnet for hosts accepting TCP on raw ESC/POS ports (9100).
 */

"use strict";

const os = require("os");
const net = require("net");

const DEFAULT_PORTS = [9100];
const CONNECT_TIMEOUT_MS = 250;
const CONCURRENCY = 48;

function localIpv4Subnets() {
  const ifaces = os.networkInterfaces();
  const out = [];
  for (const name of Object.keys(ifaces || {})) {
    for (const addr of ifaces[name] || []) {
      if (addr.family !== "IPv4" && addr.family !== 4) continue;
      if (addr.internal) continue;
      const ip = String(addr.address || "").trim();
      if (!ip) continue;
      // Prefer /24 scan window even on larger prefixes (matches Android scanner).
      const prefix = Math.max(Number(addr.cidr && addr.cidr.split("/")[1]) || 24, 24);
      out.push({ ip, prefix: Math.min(prefix, 24) });
    }
  }
  return out;
}

function hostsOnSubnet(ip, prefix) {
  const parts = ip.split(".").map((n) => Number(n));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return [];
  const scanPrefix = Math.max(Number(prefix) || 24, 24);
  const ipNum =
    ((parts[0] & 0xff) << 24) |
    ((parts[1] & 0xff) << 16) |
    ((parts[2] & 0xff) << 8) |
    (parts[3] & 0xff);
  const mask = scanPrefix === 0 ? 0 : (-1 << (32 - scanPrefix)) >>> 0;
  const network = (ipNum & mask) >>> 0;
  const broadcast = (network | (~mask >>> 0)) >>> 0;
  const start = network + 1;
  const end = broadcast - 1;
  const hosts = [];
  for (let v = start; v <= end; v++) {
    hosts.push(
      `${(v >>> 24) & 0xff}.${(v >>> 16) & 0xff}.${(v >>> 8) & 0xff}.${v & 0xff}`
    );
  }
  return hosts;
}

function portOpen(host, port, timeoutMs = CONNECT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch (_) {}
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    try {
      socket.connect(port, host);
    } catch (_) {
      done(false);
    }
  });
}

async function mapPool(items, concurrency, worker) {
  const results = [];
  let i = 0;
  async function run() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await worker(items[idx], idx);
    }
  }
  const runners = [];
  for (let c = 0; c < Math.min(concurrency, items.length); c++) {
    runners.push(run());
  }
  await Promise.all(runners);
  return results;
}

/**
 * @param {{ ports?: number[], onProgress?: (msg: string) => void, selfIps?: Set<string> }} [opts]
 * @returns {Promise<Array<{ host: string, port: number }>>}
 */
async function scanLanPrinters(opts = {}) {
  const ports = Array.isArray(opts.ports) && opts.ports.length ? opts.ports : DEFAULT_PORTS;
  const onProgress = typeof opts.onProgress === "function" ? opts.onProgress : () => {};
  const subnets = localIpv4Subnets();
  if (!subnets.length) {
    onProgress("Connect this PC to a network first.");
    return [];
  }
  const selfIps = new Set(subnets.map((s) => s.ip));
  if (opts.selfIps) {
    for (const ip of opts.selfIps) selfIps.add(ip);
  }
  const hostSet = new Set();
  for (const s of subnets) {
    for (const h of hostsOnSubnet(s.ip, s.prefix)) hostSet.add(h);
  }
  const hosts = [...hostSet].filter((h) => !selfIps.has(h));
  onProgress(`Scanning ${hosts.length} addresses for port ${ports.join(",")}…`);
  const found = [];
  await mapPool(hosts, CONCURRENCY, async (host) => {
    for (const port of ports) {
      if (await portOpen(host, port)) {
        found.push({ host, port });
        break;
      }
    }
  });
  found.sort((a, b) =>
    a.host === b.host ? a.port - b.port : a.host.localeCompare(b.host)
  );
  onProgress(
    found.length
      ? `Found ${found.length} printer${found.length === 1 ? "" : "s"}.`
      : `No printers found on port ${ports.join(",")}. You can still enter an IP.`
  );
  return found;
}

module.exports = {
  DEFAULT_PORTS,
  localIpv4Subnets,
  hostsOnSubnet,
  portOpen,
  scanLanPrinters,
};
