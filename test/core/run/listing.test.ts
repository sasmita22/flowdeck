import { describe, expect, it } from "vitest";
import { loadedRunSchema, runSummarySchema } from "../../../src/core/run/listing.js";

const summary = {
  id: "run-1",
  status: "failed",
  buildId: "b1",
  createdAt: "2026-11-15T09:00:00.000Z",
  endedAt: "2026-11-15T10:00:00.000Z",
  totalCost: 0.25,
  nodeCount: 2,
  buildName: "fix-login",
  blueprintName: "Fix and verify",
  blueprintVersion: 3,
  buildGone: false,
  number: 1,
  doneCount: 1,
};

const loaded = {
  run: summary,
  name: "fix-login",
  stages: null,
  snapshot: { runId: "run-1", status: "failed", nodes: { s1: "done", s2: "failed" } },
  activity: [],
};

const header = {
  name: "fix-login",
  blueprintName: "Fix and verify",
  blueprintVersion: 3,
  repo: "/repo",
  values: { ticket: "FD-1", draft: true },
};

const digest = "Run of Fix and verify v3: failed.\nTest: failed (tests did not pass).";

const written = {
  text: "The run failed at Test.",
  at: "2026-11-15T10:00:05.000Z",
  runStatus: "failed",
  cost: 0.0007,
};

describe("runSummarySchema", () => {
  it("keeps a summary's story line, and accepts a summary without one", () => {
    expect(runSummarySchema.parse({ ...summary, storyLine: "The run failed at Test." })).toEqual({
      ...summary,
      storyLine: "The run failed at Test.",
    });
    expect(runSummarySchema.parse(summary)).toEqual(summary);
  });
});

describe("loadedRunSchema", () => {
  it("accepts a run with no story", () => {
    expect(loadedRunSchema.parse(loaded)).toEqual(loaded);
  });

  it("keeps a story with no written account", () => {
    const run = { ...loaded, story: { header, digest, written: null } };

    expect(loadedRunSchema.parse(run)).toEqual(run);
  });

  it("keeps a story with its written account", () => {
    const run = { ...loaded, story: { header, digest, written } };

    expect(loadedRunSchema.parse(run)).toEqual(run);
  });

  it("keeps the branch in a story's header", () => {
    const run = {
      ...loaded,
      story: { header: { ...header, branch: "flowdeck/fix" }, digest, written },
    };

    expect(loadedRunSchema.parse(run)).toEqual(run);
  });

  it("rejects a story missing its header or its digest", () => {
    expect(() => loadedRunSchema.parse({ ...loaded, story: { digest, written } })).toThrow();
    expect(() => loadedRunSchema.parse({ ...loaded, story: { header, written } })).toThrow();
  });
});
