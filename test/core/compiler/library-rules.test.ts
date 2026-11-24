import { describe, expect, it } from "vitest";
import { flowProblems } from "../../../src/core/compiler/flow-problems.js";
import { validate } from "../../../src/core/compiler/validate.js";
import { newProblems } from "../../../src/core/flow/blueprint-edits.js";
import type { BlueprintKind, LibraryLookup } from "../../../src/core/flow/libraries.js";
import { parseFlow, type Flow } from "../../../src/core/flow/schema.js";
import {
  flowSettings,
  output,
  sessionContainer,
  thenWire,
  trigger,
  wire,
  workspaceContainer,
} from "../../fixtures/flow-builders.js";

const libraryNode = (id: string, libraryId: string, label = id) => ({
  id,
  label: "Library",
  position: { x: 0, y: 0 },
  type: "library",
  settings: { libraryId, label, overrides: {} },
});

const kinds: Record<string, BlueprintKind> = {
  nodes: "node-library",
  sessions: "session-library",
  draft: "incomplete",
  flow: "workflow",
};

const lookup: LibraryLookup = (flowId) => {
  const kind = kinds[flowId];
  return kind === undefined ? undefined : { name: `${flowId} blueprint`, kind, sessions: [] };
};

const chain = (ids: string[]) =>
  ids.slice(1).map((id, index) => thenWire(ids[index] as string, id));

const loose = (...uses: ReturnType<typeof libraryNode>[]): Flow =>
  parseFlow({
    nodes: [trigger("canvas-start"), ...uses, output("canvas-stop")],
    wires: chain(["canvas-start", ...uses.map((use) => use.id), "canvas-stop"]),
    containers: [],
    settings: flowSettings,
  });

const inSession = (use: ReturnType<typeof libraryNode>): Flow =>
  parseFlow({
    nodes: [
      trigger("canvas-start"),
      trigger("s-start"),
      use,
      output("s-stop"),
      output("canvas-stop"),
    ],
    wires: [
      wire("canvas-start", "out", "session-1", "flow-in"),
      ...chain(["s-start", use.id, "s-stop"]),
      wire("session-1", "flow-out", "canvas-stop", "in"),
    ],
    containers: [sessionContainer(["s-start", use.id, "s-stop"])],
    settings: flowSettings,
  });

const workflow = (use: ReturnType<typeof libraryNode>, where: "workspace" | "loose"): Flow => {
  const inWorkspace = where === "workspace";
  return parseFlow({
    nodes: [
      trigger("canvas-start"),
      trigger("w-start"),
      use,
      output("w-stop"),
      output("canvas-stop"),
    ],
    wires: inWorkspace
      ? [
          wire("canvas-start", "out", "workspace-1", "flow-in"),
          ...chain(["w-start", use.id, "w-stop"]),
          wire("workspace-1", "flow-out", "canvas-stop", "in"),
        ]
      : [
          wire("canvas-start", "out", "workspace-1", "flow-in"),
          thenWire("w-start", "w-stop"),
          wire("workspace-1", "flow-out", use.id, "in"),
          thenWire(use.id, "canvas-stop"),
        ],
    containers: [
      workspaceContainer(inWorkspace ? ["w-start", use.id, "w-stop"] : ["w-start", "w-stop"]),
    ],
    settings: flowSettings,
  });
};

const ruleProblems = (flow: Flow, rule: string) =>
  validate(flow, lookup)
    .filter((problem) => problem.rule === rule)
    .map(({ node, field }) => ({ node, field }));

describe("library-use", () => {
  it.each([
    ["an incomplete blueprint", "draft"],
    ["a workflow", "flow"],
    ["a blueprint that no longer exists", "gone"],
  ])("refuses a library node naming %s", (_, libraryId) => {
    expect(ruleProblems(loose(libraryNode("use", libraryId)), "library-use")).toEqual([
      { node: "use", field: undefined },
    ]);
  });

  it("says a missing library no longer exists", () => {
    const [problem] = validate(loose(libraryNode("use", "gone", "Android App")), lookup);

    expect(problem?.message).toContain("names a blueprint that no longer exists");
  });

  it.each([
    ["a session container", inSession(libraryNode("use", "sessions"))],
    ["the workspace", workflow(libraryNode("use", "sessions"), "workspace")],
  ])("refuses a session library inside %s", (_, flow) => {
    expect(ruleProblems(flow, "library-use")).toEqual([{ node: "use", field: undefined }]);
  });

  it.each([
    ["a session container", inSession(libraryNode("use", "nodes"))],
    ["the workspace", workflow(libraryNode("use", "nodes"), "workspace")],
    ["a blueprint with no workspace", loose(libraryNode("use", "nodes"))],
  ])("accepts a node library inside %s", (_, flow) => {
    expect(ruleProblems(flow, "library-use")).toEqual([]);
  });

  it.each([
    ["a workflow", workflow(libraryNode("use", "sessions"), "loose")],
    ["a blueprint with no workspace", loose(libraryNode("use", "sessions"))],
  ])("accepts a session library loose in %s", (_, flow) => {
    expect(ruleProblems(flow, "library-use")).toEqual([]);
  });

  it("refuses a node library loose in a workflow", () => {
    expect(ruleProblems(workflow(libraryNode("use", "nodes"), "loose"), "library-use")).toEqual([
      { node: "use", field: undefined },
    ]);
  });

  it("treats every library as unknown without a lookup", () => {
    expect(
      validate(loose(libraryNode("use", "nodes"))).map(({ rule, node }) => ({ rule, node })),
    ).toEqual([{ rule: "library-use", node: "use" }]);
  });
});

describe("library-labels", () => {
  it("refuses two labels that are the same once normalised, on both nodes", () => {
    const flow = loose(
      libraryNode("a", "nodes", "Android App"),
      libraryNode("b", "nodes", "android-app"),
    );

    expect(ruleProblems(flow, "library-labels")).toEqual([
      { node: "a", field: "label" },
      { node: "b", field: "label" },
    ]);
  });

  it("accepts different labels for the same library", () => {
    const flow = loose(
      libraryNode("a", "nodes", "Android App"),
      libraryNode("b", "nodes", "iOS App"),
    );

    expect(ruleProblems(flow, "library-labels")).toEqual([]);
  });

  it.each([
    ["contains a dot", "android.app"],
    ["is empty", ""],
    ["is only spaces", "  "],
  ])("refuses a label that %s", (_, label) => {
    expect(ruleProblems(loose(libraryNode("use", "nodes", label)), "library-labels")).toEqual([
      { node: "use", field: "label" },
    ]);
  });
});

describe("the lookup through flow checks", () => {
  it("reaches the library rules from flowProblems", () => {
    const flow = loose(libraryNode("use", "nodes"));

    expect(flowProblems(flow, lookup)).toEqual([]);
    expect(flowProblems(flow).map(({ rule }) => rule)).toEqual(["library-use"]);
  });

  it("reaches the library rules from newProblems", () => {
    const before = loose();
    const after = loose(libraryNode("use", "draft"));

    expect(newProblems(before, after, lookup).map(({ rule, node }) => ({ rule, node }))).toEqual([
      { rule: "library-use", node: "use" },
    ]);
    expect(newProblems(before, loose(libraryNode("use", "nodes")), lookup)).toEqual([]);
  });
});
