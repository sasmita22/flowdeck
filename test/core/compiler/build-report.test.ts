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
  needs: [
    { nodeId: "n3", items: [{ name: "repo-conventions", what: "Reads the repo's lint rules." }] },
  ],
  shared: [{ name: "repo-conventions", kind: "skill", usedBy: ["n3", "n4"] }],
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

  it("accepts a shared command", () => {
    const report = {
      ...full,
      shared: [{ name: "run-checks", kind: "command", usedBy: ["n3", "n4"] }],
    };
    expect(buildReportSchema.safeParse(report).success).toBe(true);
  });

  it.each<[string, Record<string, unknown>, (string | number)[]]>([
    [
      "a shared entry of kind agent",
      { shared: [{ name: "x", kind: "agent", usedBy: ["n3", "n4"] }] },
      ["shared", 0, "kind"],
    ],
    [
      "a shared entry used by one agent",
      { shared: [{ name: "x", kind: "skill", usedBy: ["n3"] }] },
      ["shared", 0, "usedBy"],
    ],
    [
      "an unknown key in a shared entry",
      { shared: [{ name: "x", kind: "skill", usedBy: ["n3", "n4"], extra: true }] },
      ["shared", 0],
    ],
    [
      "an unknown key in a needs entry",
      { needs: [{ nodeId: "n3", items: [], extra: true }] },
      ["needs", 0],
    ],
    [
      "a need missing what",
      { needs: [{ nodeId: "n3", items: [{ name: "x" }] }] },
      ["needs", 0, "items", 0, "what"],
    ],
  ])("rejects %s, at its path", (_, change, path) => {
    const result = buildReportSchema.safeParse({ ...full, ...change });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path)).toEqual([path]);
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
      needs: [],
      shared: [],
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
