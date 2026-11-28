import { describe, expect, it } from "vitest";
import { flowProblems } from "../../../src/core/compiler/flow-problems.js";
import { rule as variableClash } from "../../../src/core/compiler/rules/variable-clash.js";
import { validate } from "../../../src/core/compiler/validate.js";
import { newProblems } from "../../../src/core/flow/blueprint-edits.js";
import type { BlueprintKind, LibraryLookup } from "../../../src/core/flow/libraries.js";
import { parseFlow, type Flow } from "../../../src/core/flow/schema.js";
import {
  branch,
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
  return kind === undefined
    ? undefined
    : { name: `${flowId} blueprint`, kind, sessions: [], uses: [], sends: [] };
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

const ruleProblems = (flow: Flow, rule: string, libraries: LibraryLookup = lookup) =>
  validate(flow, libraries)
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

  it("allows a node library loose in a workflow", () => {
    expect(ruleProblems(workflow(libraryNode("use", "nodes"), "loose"), "library-use")).toEqual([]);
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

describe("library-loops", () => {
  const usesOf: Record<string, { name: string; uses: string[] }> = {
    a: { name: "Loop A", uses: ["b"] },
    b: { name: "Loop B", uses: ["a"] },
    left: { name: "Left", uses: ["shared"] },
    right: { name: "Right", uses: ["shared"] },
    shared: { name: "Shared", uses: [] },
  };

  const looping: LibraryLookup = (flowId) => {
    const library = usesOf[flowId];
    return library === undefined
      ? undefined
      : { name: library.name, kind: "node-library", sessions: [], uses: library.uses, sends: [] };
  };

  const offPath = (use: ReturnType<typeof libraryNode>): Flow =>
    parseFlow({
      nodes: [trigger("canvas-start"), use, output("canvas-stop")],
      wires: chain(["canvas-start", "canvas-stop"]),
      containers: [],
      settings: flowSettings,
    });

  it("refuses a library that reaches back to itself, naming the path", () => {
    const problems = validate(loose(libraryNode("use", "a")), looping).filter(
      ({ rule }) => rule === "library-loops",
    );

    expect(problems).toEqual([
      {
        rule: "library-loops",
        node: "use",
        message: "Loop A makes a loop: Loop A → Loop B → Loop A",
      },
    ]);
  });

  it("refuses a loop through a library node off the main flow", () => {
    expect(ruleProblems(offPath(libraryNode("use", "a")), "library-loops", looping)).toEqual([
      { node: "use", field: undefined },
    ]);
  });

  it("accepts one library shared by two library nodes", () => {
    const flow = loose(libraryNode("l", "left"), libraryNode("r", "right"));

    expect(ruleProblems(flow, "library-loops", looping)).toEqual([]);
  });

  it.each([
    ["no library", ""],
    ["an unknown library", "gone"],
  ])("says nothing about a library node naming %s", (_, libraryId) => {
    expect(ruleProblems(loose(libraryNode("use", libraryId)), "library-loops", looping)).toEqual(
      [],
    );
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

describe("variable-clash", () => {
  const sending: LibraryLookup = (flowId) => {
    const sends = { asks: ["approved"], "asks-too": ["approved"], keeps: [] }[flowId];
    return sends === undefined
      ? undefined
      : { name: `${flowId} blueprint`, kind: "node-library", sessions: [], uses: [], sends };
  };

  const host = (...members: { id: string; type: string; label?: string }[]): Flow => {
    const path = ["canvas-start", ...members.map(({ id }) => id), "canvas-stop"];
    const portsOf = (id: string) =>
      members.find((member) => member.id === id)?.type === "branch" ? ["yes", "no"] : ["out"];
    return parseFlow({
      nodes: [trigger("canvas-start"), ...members, output("canvas-stop")],
      wires: path
        .slice(1)
        .flatMap((to, index) =>
          portsOf(path[index] as string).map((port) => wire(path[index] as string, port, to, "in")),
        ),
      containers: [],
      settings: flowSettings,
    });
  };

  const decide = (id: string, settings: Record<string, unknown> = {}) => ({
    ...branch(id, "approved"),
    settings: { variable: "approved", ...settings },
  });

  const clashes = (flow: Flow) =>
    variableClash.check(flow, { libraries: sending }).map(({ node, field }) => ({ node, field }));

  it("reports a library sending up a name the blueprint's own Branch already has, on the Library node", () => {
    expect(clashes(host(decide("own"), libraryNode("use", "asks")))).toEqual([
      { node: "use", field: undefined },
    ]);
  });

  it("names the variable and the Branch that has it first", () => {
    const [problem] = variableClash.check(
      host({ ...decide("own"), label: "Ready?" }, libraryNode("use", "asks", "Review")),
      { libraries: sending },
    );

    expect(problem?.message).toContain('"approved"');
    expect(problem?.message).toContain("Ready?");
  });

  it.each([
    ["typed", {}],
    ["picked to share", { shared: true }],
  ])("reports the blueprint's own Branch %s after a library sends the name up", (_, settings) => {
    expect(clashes(host(libraryNode("use", "asks"), decide("own", settings)))).toEqual([
      { node: "own", field: "variable" },
    ]);
  });

  it.each([
    ["asks", "asks-too"],
    ["asks-too", "asks"],
  ])("reports the later of two libraries sending up one name, %s first", (first, second) => {
    expect(clashes(host(libraryNode("one", first), libraryNode("two", second)))).toEqual([
      { node: "two", field: undefined },
    ]);
  });

  it("reports the later copy of one library placed twice", () => {
    expect(
      clashes(host(libraryNode("one", "asks", "one"), libraryNode("two", "asks", "two"))),
    ).toEqual([{ node: "two", field: undefined }]);
  });

  it("accepts a library that keeps the name inside beside the blueprint's own Branch", () => {
    expect(clashes(host(decide("own"), libraryNode("use", "keeps")))).toEqual([]);
  });

  it("leaves two of the blueprint's own Branches to variable-unique", () => {
    expect(clashes(host(decide("one"), decide("two")))).toEqual([]);
  });
});
