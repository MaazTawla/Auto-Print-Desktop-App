"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createProcessedJobsStore } = require("../src/processed-jobs");

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
});
