"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  createProcessedJobsStore,
  STATUS_PRINTING,
  STATUS_PROCESSED,
} = require("../src/processed-jobs");

describe("processed-jobs", () => {
  it("marks and remembers job_ids durably", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pj-"));
    const filePath = path.join(dir, "processed-jobs.json");
    const store = createProcessedJobsStore({ filePath, maxEntries: 5 });
    assert.equal(store.has("j1"), false);
    store.mark("j1");
    assert.equal(store.has("j1"), true);

    const store2 = createProcessedJobsStore({ filePath, maxEntries: 5 });
    assert.equal(store2.has("j1"), true);
  });

  it("trims to maxEntries", () => {
    const store = createProcessedJobsStore({ maxEntries: 3 });
    store.mark("a");
    store.mark("b");
    store.mark("c");
    store.mark("d");
    assert.equal(store.size(), 3);
    assert.equal(store.has("a"), false);
    assert.equal(store.has("d"), true);
  });

  it("markPrinting is durable and distinct from processed", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pj-print-"));
    const filePath = path.join(dir, "processed-jobs.json");
    const store = createProcessedJobsStore({ filePath, maxEntries: 10 });
    assert.equal(store.isPrinting("job-9"), false);
    assert.equal(store.has("job-9"), false);
    assert.equal(store.markPrinting("job-9"), true);
    assert.equal(store.isPrinting("job-9"), true);
    assert.equal(store.has("job-9"), false);
    assert.equal(store.get("job-9").status, STATUS_PRINTING);

    const reloaded = createProcessedJobsStore({ filePath, maxEntries: 10 });
    assert.equal(reloaded.isPrinting("job-9"), true);
    assert.equal(reloaded.has("job-9"), false);
  });

  it("mark after markPrinting clears printing and sets processed", () => {
    const store = createProcessedJobsStore({ maxEntries: 10 });
    store.markPrinting("job-1");
    assert.equal(store.isPrinting("job-1"), true);
    store.mark("job-1");
    assert.equal(store.isPrinting("job-1"), false);
    assert.equal(store.has("job-1"), true);
    assert.equal(store.get("job-1").status, STATUS_PROCESSED);
  });

  it("markPrinting is a no-op when already processed", () => {
    const store = createProcessedJobsStore({ maxEntries: 10 });
    store.mark("done");
    assert.equal(store.markPrinting("done"), false);
    assert.equal(store.has("done"), true);
    assert.equal(store.isPrinting("done"), false);
  });

  it("loads legacy entries without status as processed", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pj-legacy-"));
    const filePath = path.join(dir, "processed-jobs.json");
    fs.writeFileSync(
      filePath,
      JSON.stringify({ entries: [{ id: "legacy-1", at: 1000 }] }),
      "utf8"
    );
    const store = createProcessedJobsStore({ filePath, maxEntries: 10 });
    assert.equal(store.has("legacy-1"), true);
    assert.equal(store.isPrinting("legacy-1"), false);
  });

  it("prefers dropping processed over printing when trimming", () => {
    const store = createProcessedJobsStore({ maxEntries: 2 });
    function tick() {
      const end = Date.now() + 2;
      while (Date.now() < end) {
        /* spin for distinct `at` timestamps */
      }
    }
    store.mark("old-processed");
    tick();
    store.markPrinting("in-flight");
    tick();
    store.mark("newer-processed");
    // max 2: keep in-flight printing + newest processed
    assert.equal(store.size(), 2);
    assert.equal(store.isPrinting("in-flight"), true);
    assert.equal(store.has("newer-processed"), true);
    assert.equal(store.has("old-processed"), false);
  });
});

describe("processed-jobs crash window (printing → PRINT_INTERRUPTED)", () => {
  it("simulates crash after markPrinting: redelivery sees printing not processed", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pj-crash-"));
    const filePath = path.join(dir, "processed-jobs.json");
    // Session 1: about to print, then "crash" before mark processed
    const session1 = createProcessedJobsStore({ filePath, maxEntries: 50 });
    session1.markPrinting("job-crash-1");
    assert.equal(session1.isPrinting("job-crash-1"), true);
    assert.equal(session1.has("job-crash-1"), false);

    // Session 2 (redelivery after restart): marker still present
    const session2 = createProcessedJobsStore({ filePath, maxEntries: 50 });
    assert.equal(session2.isPrinting("job-crash-1"), true);
    assert.equal(session2.has("job-crash-1"), false);
    // Handler would fail-ack PRINT_INTERRUPTED then mark processed
    session2.mark("job-crash-1");
    assert.equal(session2.isPrinting("job-crash-1"), false);
    assert.equal(session2.has("job-crash-1"), true);

    // Session 3: further redelivery is plain processed dedupe
    const session3 = createProcessedJobsStore({ filePath, maxEntries: 50 });
    assert.equal(session3.has("job-crash-1"), true);
    assert.equal(session3.isPrinting("job-crash-1"), false);
  });
});
