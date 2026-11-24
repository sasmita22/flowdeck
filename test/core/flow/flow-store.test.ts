import { describe, expect, it } from "vitest";
import {
  blueprintFacts,
  flowSummarySchema,
  noBlueprintFacts,
  saveFlowResultSchema,
} from "../../../src/core/flow/flow-store.js";
import { parseFlow } from "../../../src/core/flow/schema.js";
import { flowSettings, output, thenWire, trigger } from "../../fixtures/flow-builders.js";

const libraryNode = (id: string, libraryId: string) => ({
  id,
  label: "Library",
  position: { x: 0, y: 0 },
  type: "library",
  settings: { libraryId, label: id, overrides: {} },
});

describe("blueprintFacts", () => {
  it("lists the libraries the blueprint uses, on its path and off it", () => {
    const flow = parseFlow({
      nodes: [
        trigger("canvas-start"),
        libraryNode("use", "on-path"),
        output("canvas-stop"),
        libraryNode("stray", "off-path"),
      ],
      wires: [thenWire("canvas-start", "use"), thenWire("use", "canvas-stop")],
      containers: [],
      settings: flowSettings,
    });

    expect(blueprintFacts(flow, () => undefined).uses).toEqual(["on-path", "off-path"]);
  });

  it("uses no libraries when there is no saved blueprint", () => {
    expect(noBlueprintFacts.uses).toEqual([]);
  });
});

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
    variables: [],
    kind: "workflow",
    sessions: [],
    uses: ["lib-a"],
  };

  it("keeps the latest version's Build configuration and the variables it finds", () => {
    const buildConfig = { repo: "/r/shop", base: "dev" };
    const variables = [{ name: "ticket", kind: "text", nodeIds: ["a1"] }];

    expect(flowSummarySchema.parse({ ...summary, buildConfig, variables })).toEqual({
      ...summary,
      buildConfig,
      variables,
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
      buildConfig: { base: "main" },
      workingFolder: { kind: "worktree", branch: "main" },
    });

    expect(parsed).not.toHaveProperty("workingFolder");
  });

  it.each(["workflow", "node-library", "session-library", "incomplete"])(
    "keeps the kind %s",
    (kind) => {
      const kept = { ...summary, kind, buildConfig: null };

      expect(flowSummarySchema.parse(kept)).toEqual(kept);
    },
  );

  it("keeps a library's sessions and the group of each variable a library asks for", () => {
    const library = {
      ...summary,
      kind: "session-library",
      buildConfig: null,
      sessions: [{ id: "s1", name: "android", repo: "/r/a", branch: "main", model: "haiku" }],
      variables: [
        {
          name: "android-app.isFullScan",
          kind: "yes-no",
          nodeIds: ["android-app-scan"],
          group: { path: "android-app", name: "Android" },
        },
      ],
    };

    expect(flowSummarySchema.parse(library)).toEqual(library);
  });

  it("rejects a summary with no uses", () => {
    expect(
      flowSummarySchema.safeParse({ ...summary, buildConfig: null, uses: undefined }).success,
    ).toBe(false);
  });

  it("rejects a summary with no sessions", () => {
    expect(
      flowSummarySchema.safeParse({ ...summary, buildConfig: null, sessions: undefined }).success,
    ).toBe(false);
  });

  it.each([
    ["no kind", undefined],
    ["an unknown kind", "group"],
    ["the old library kind", "library"],
  ])("rejects a summary with %s", (_, kind) => {
    expect(flowSummarySchema.safeParse({ ...summary, buildConfig: null, kind }).success).toBe(
      false,
    );
  });
});
