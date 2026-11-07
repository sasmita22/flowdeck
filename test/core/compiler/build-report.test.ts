import { describe, expect, it } from "vitest";
import {
  BuildReportParseError,
  buildReportSchema,
  emptyReport,
  parseBuildReport,
} from "../../../src/core/compiler/build-report.js";

const full = {
  version: 1,
  questions: [
    { nodeId: "n1", text: "Which file does the reviewer read?" },
    { nodeId: "n2", text: "Who writes plan.md?", otherNodeId: "n1" },
  ],
  merges: [{ nodeIds: ["n3", "n4"], reason: "Both review the same diff the same way." }],
  keptApart: [{ nodeIds: ["n5", "n6", "n7"], reason: "Each checks a different platform." }],
  mixedJobs: [{ nodeId: "n8", note: "Writes the code and reviews it." }],
  pieces: [
    { path: "plugin/agents/reviewer.md", status: "done" },
    { path: "plugin/skills/plan/SKILL.md", status: "question" },
  ],
};

describe("buildReportSchema", () => {
  it("accepts a report with every field", () => {
    expect(buildReportSchema.safeParse(full).success).toBe(true);
  });

  it("rejects a piece status other than done or question", () => {
    const report = { ...full, pieces: [{ path: "plugin/agents/a.md", status: "skipped" }] };
    expect(buildReportSchema.safeParse(report).success).toBe(false);
  });

  it("rejects a merge with only one node, at that merge's path", () => {
    const report = { ...full, merges: [{ nodeIds: ["n3"], reason: "Alone." }] };
    const result = buildReportSchema.safeParse(report);
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path)).toEqual([["merges", 0, "nodeIds"]]);
  });

  it("rejects a kept-apart entry with only one node, at its path", () => {
    const report = { ...full, keptApart: [{ nodeIds: ["n5"], reason: "Alone." }] };
    const result = buildReportSchema.safeParse(report);
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path)).toEqual([["keptApart", 0, "nodeIds"]]);
  });

  it("rejects an unknown key, naming it", () => {
    const report = { ...full, merges: [{ ...full.merges[0], extra: true }] };
    const result = buildReportSchema.safeParse(report);
    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual([
      expect.objectContaining({ code: "unrecognized_keys", keys: ["extra"], path: ["merges", 0] }),
    ]);
  });

  it("rejects a version other than 1", () => {
    expect(buildReportSchema.safeParse({ ...full, version: 2 }).success).toBe(false);
  });
});

describe("emptyReport", () => {
  it("parses and holds nothing", () => {
    expect(buildReportSchema.safeParse(emptyReport()).success).toBe(true);
    expect(emptyReport()).toEqual({
      version: 1,
      questions: [],
      merges: [],
      keptApart: [],
      mixedJobs: [],
      pieces: [],
    });
  });
});

describe("parseBuildReport", () => {
  it("parses valid report text", () => {
    expect(parseBuildReport(JSON.stringify(full))).toEqual(full);
  });

  it("throws on malformed JSON", () => {
    expect(() => parseBuildReport("{ not json")).toThrow(SyntaxError);
  });

  it("throws on a schema violation, naming the path", () => {
    const text = JSON.stringify({ ...full, merges: [{ nodeIds: ["n3"], reason: "Alone." }] });
    let thrown: unknown;
    try {
      parseBuildReport(text);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(BuildReportParseError);
    const parseError = thrown as BuildReportParseError;
    expect(parseError.issues.map((issue) => issue.path)).toEqual([["merges", 0, "nodeIds"]]);
    expect(parseError.message).toContain("merges[0].nodeIds");
  });
});
