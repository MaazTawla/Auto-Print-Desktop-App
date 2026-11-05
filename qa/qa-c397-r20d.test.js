"use strict";
const { describe, it } = require("node:test"); const assert = require("node:assert/strict");
const L = require("../src/printer-field-limits"); const { createPrinterRegistry: R } = require("../src/printer-registry");
const D = require("../src/discovered-printer"); const V = require("../src/lan-host-validation");
const cp = (s) => Array.from(s).length; const lone = (s) => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);
describe("R20D truncation", () => {
  const units = { ascii: "a", cjk: "漢", astral: "𝒜", flag: "🇵🇰", comb: "e\u0301\u0302", fam: "👨‍👩‍👧‍👦" };
  for (const max of [16, 253, 255]) it("≤ " + max + " code points, prefix, no lone surrogate", () => { for (const u of Object.values(units)) for (let n = max - 8; n <= max + 8; n++) for (const pre of ["", "x", "xy"]) { const s = pre + u.repeat(n); const o = L.truncateAtGraphemeBoundary(s, max); assert.ok(cp(o) <= max); assert.ok(!lone(o)); assert.ok(s.startsWith(o)); if (cp(s) <= max) assert.equal(o, s); } });
  it("counts code points not UTF-16: 255 astral kept whole, 255 fam-emoji graphemes cut", () => { const a = "𝒜".repeat(255); assert.equal(L.truncateAtGraphemeBoundary(a, 255), a); const a2 = "𝒜".repeat(256); assert.equal(cp(L.truncateAtGraphemeBoundary(a2, 255)), 255); const f = "👨‍👩‍👧‍👦".repeat(40); const o = L.truncateAtGraphemeBoundary(f, 255); assert.equal(cp(o), 252); });
  it("fallback without Segmenter never splits pairs", () => { const S = Intl.Segmenter; Intl.Segmenter = undefined; try { const o = L.truncateAtGraphemeBoundary("𝒜".repeat(300), 255); assert.equal(cp(o), 255); assert.ok(!lone(o)); } finally { Intl.Segmenter = S; } });
  it("payload caps every field; status 16", () => { const r = R(); r.upsert({ external_id: "lan:a:9100", name: "n".repeat(300), model: "m".repeat(300), status: "x".repeat(30), status_detail: "d".repeat(300), ip_address: "1".repeat(300) }); const p = r.toSyncPayload()[0]; assert.equal(cp(p.name), 255); assert.equal(cp(p.model), 255); assert.equal(cp(p.status_detail), 255); assert.equal(cp(p.ip_address), 255); assert.equal(p.status, "error"); });
});
describe("R20D external_id", () => {
  it("≤255 unchanged (exact); 256 hashed to 255, deterministic, idempotent, distinct prefixes", () => { const s = "win:" + "a".repeat(251); assert.equal(L.capExternalId(s), s); for (const x of ["win:Kitchen", "lan:192.168.1.5:9100", "bt:AA:BB", "win:" + "𝒜".repeat(251)]) assert.equal(L.capExternalId(x), x); const t = s + "b"; const c = L.capExternalId(t); assert.equal(cp(c), 255); assert.match(c, /#[0-9a-f]{12}$/); assert.equal(L.capExternalId(t), c); assert.equal(L.capExternalId(c), c); assert.notEqual(L.capExternalId(s + "c"), c); });
  it("hash is sha256(original)[:12] (stable across processes)", () => { const t = "win:" + "a".repeat(260); assert.ok(L.capExternalId(t).endsWith("#" + require("crypto").createHash("sha256").update(t).digest("hex").slice(0, 12))); });
  it("short-id registry round trip keeps ids", () => { const r = R(); r.upsert({ external_id: "win:Kitchen", name: "K" }); r.syncFromWindowsList([{ name: "Kitchen" }]); assert.deepEqual(r.list().map((p) => p.external_id), ["win:Kitchen"]); });
  it("lanExternalId wired: long host capped", () => { assert.equal(cp(D.lanExternalId("h".repeat(260), 9100)), 255); });
  it("manual validation: host 253 ok/254 rejected; eid over 255 rejected", () => { assert.match(V.validateManualLan("h".repeat(254), "9100"), /253/); assert.equal(V.validateManualLan("h".repeat(246), "9100"), null); assert.match(V.validateManualLan("h".repeat(247), "9100"), /external id/); });
  it("R20D-M1: long Windows printer survives syncFromWindowsList", () => {
    const name = "P".repeat(300);
    const r = R();
    r.syncFromWindowsList([{ name }]);
    assert.equal(r.list().length, 1);
    const eid = r.list()[0].external_id;
    assert.equal(cp(eid), 255);
    assert.match(eid, /#[0-9a-f]{12}$/);
    r.upsert({ external_id: eid, name: "Custom", server_id: 42, is_default: true });
    r.syncFromWindowsList([{ name }]);
    assert.equal(r.list().length, 1);
    const row = r.list()[0];
    assert.equal(row.server_id, 42);
    assert.equal(row.name, "Custom");
    assert.equal(row.is_default, true);
    assert.equal(row.external_id, eid);
  });
  it("R20D-M2: hydrate keeps default for a stored over-255 id", () => {
    const n = "win:" + "P".repeat(300);
    const r = R();
    r.hydrate({ printers: [{ external_id: n, name: "x" }, { external_id: "win:B", name: "B" }], defaultExternalId: n });
    const d = r.serialize().defaultExternalId;
    assert.ok(d);
    assert.equal(d, L.capExternalId(n));
    assert.equal(r.getDefault() && r.getDefault().name, "x");
    const route = r.routeMessage({});
    assert.equal(route.ok, true);
    assert.equal(route.matchedBy, "default");
    assert.equal(route.printer.name, "x");
  });
});
describe("R20D 422", () => {
  it("names printer from BE details shape", () => { assert.match(L.formatPrinterSyncValidationError({ message: "m", details: { "printers.1.name": ["x"] } }, [{ name: "A" }, { name: "Kitchen" }]), /"Kitchen": name/); });
  it("index.html form has maxlength + code-point checks", () => { const h = require("fs").readFileSync(require("path").join(__dirname, "..", "index.html"), "utf8"); assert.match(h, /id="settings-manual-printer-name"[^>]*maxlength="510"/); assert.match(h, /id="settings-manual-printer-host"[^>]*maxlength="506"/); assert.match(h, /codePointLen\(name\) > 255/); assert.match(h, /codePointLen\(externalId\) > 255/); });
  it("main add-discovered-printer reports failed sync", () => { const m = require("fs").readFileSync(require("path").join(__dirname, "..", "src", "main.js"), "utf8"); const i = m.indexOf('ipcMain.handle("add-discovered-printer"'); const end = m.indexOf('ipcMain.handle("set-printer-mapping"', i + 1); const slice = m.slice(i, end > i ? end : i + 3500); assert.match(slice, /sync && sync\.ok === false && !sync\.skipped/); assert.match(slice, /added:\s*row/); });
});
