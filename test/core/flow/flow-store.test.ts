import { describe, expect, it } from "vitest";
import { flowSummarySchema, saveFlowResultSchema } from "../../../src/core/flow/flow-store.js";

describe("saveFlowResultSchema", () => {
  it.each([
    { kind: "saved", flowId: "f1", version: 3 },
    { kind: "error", message: "disk full" },
  ])("accepts a $kind result", (result) => {
    expect(saveFlowResultSchema.parse(result)).toEqual(result);
  });

  it.each([
    ["no kind", { flowId: "f1", version: 1 }],
    ["an unknown kind", { kind: "loaded", flowId: "f1", version: 1 }],
    ["a non-number version", { kind: "saved", flowId: "f1", version: "1" }],
    ["a missing flow id", { kind: "saved", version: 1 }],
    ["an error without a message", { kind: "error" }],
    ["null", null],
    ["a string", "saved"],
  ])("rejects %s", (_, input) => {
    expect(saveFlowResultSchema.safeParse(input).success).toBe(false);
  });
});

describe("flowSummarySchema", () => {
  const summary = {
    flowId: "f1",
    name: "Bugfix",
    createdAt: "2026-01-01T00:00:00.000Z",
    versions: 2,
    lastSavedAt: "2026-01-02T00:00:00.000Z",
    pinned: false,
  };

  it("keeps the repo, base and variables of the latest version's Build configuration", () => {
    const buildConfig = {
      repo: "/r/shop",
      base: "dev",
      variables: [{ name: "ticket", kind: "text" }],
    };

    expect(flowSummarySchema.parse({ ...summary, buildConfig })).toEqual({
      ...summary,
      buildConfig,
    });
  });

  it("accepts a blueprint with no saved version and so no Build configuration", () => {
    const empty = { ...summary, versions: 0, lastSavedAt: null, buildConfig: null };

    expect(flowSummarySchema.parse(empty)).toEqual(empty);
  });

  it("keeps a pinned blueprint pinned", () => {
    const pinned = { ...summary, pinned: true, buildConfig: null };

    expect(flowSummarySchema.parse(pinned)).toEqual(pinned);
  });

  it("carries no working folder", () => {
    const parsed = flowSummarySchema.parse({
      ...summary,
      buildConfig: { base: "main", variables: [] },
      workingFolder: { kind: "worktree", branch: "main" },
    });

    expect(parsed).not.toHaveProperty("workingFolder");
  });
});
