import { describe, expect, it } from "vitest";
import { reasonNaming } from "../../../src/core/compiler/problems.js";
import { rule as libraryUse } from "../../../src/core/compiler/rules/library-use.js";
import { validate } from "../../../src/core/compiler/validate.js";
import { libraryRefusal, loopRefusal } from "../../../src/core/flow/library-checks.js";
import {
  loopReason,
  type BlueprintKind,
  type LibraryLookup,
} from "../../../src/core/flow/libraries.js";
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

type Library = { name: string; kind: BlueprintKind; uses?: string[] };

const lookupOf =
  (libraries: Record<string, Library>): LibraryLookup =>
  (flowId) => {
    const library = libraries[flowId];
    return library === undefined
      ? undefined
      : { name: library.name, kind: library.kind, sessions: [], uses: library.uses ?? [] };
  };

const lookup = lookupOf({
  nodes: { name: "Node steps", kind: "node-library" },
  sessions: { name: "Session steps", kind: "session-library" },
  draft: { name: "Draft steps", kind: "incomplete" },
  flow: { name: "Whole flow", kind: "workflow" },
  unsafe: { name: "Android/App", kind: "node-library" },
});

const nameIn = (libraries: LibraryLookup) => (id: string) => libraries(id)?.name;

const libraryNode = (libraryId: string, label = "use") => ({
  id: "use",
  label: "Library",
  position: { x: 0, y: 0 },
  type: "library",
  settings: { libraryId, label, overrides: {} },
});

type Use = ReturnType<typeof libraryNode>;

const chain = (ids: string[]) =>
  ids.slice(1).map((id, index) => thenWire(ids[index] as string, id));

const ids = (use?: Use) => (use === undefined ? [] : [use.id]);

const loose = (use?: Use): Flow =>
  parseFlow({
    nodes: [trigger("canvas-start"), ...(use ? [use] : []), output("canvas-stop")],
    wires: chain(["canvas-start", ...ids(use), "canvas-stop"]),
    containers: [],
    settings: flowSettings,
  });

const inSession = (use?: Use): Flow =>
  parseFlow({
    nodes: [
      trigger("canvas-start"),
      trigger("s-start"),
      ...(use ? [use] : []),
      output("s-stop"),
      output("canvas-stop"),
    ],
    wires: [
      wire("canvas-start", "out", "session-1", "flow-in"),
      ...chain(["s-start", ...ids(use), "s-stop"]),
      wire("session-1", "flow-out", "canvas-stop", "in"),
    ],
    containers: [sessionContainer(["s-start", ...ids(use), "s-stop"])],
    settings: flowSettings,
  });

const inWorkspace = (use?: Use): Flow =>
  parseFlow({
    nodes: [
      trigger("canvas-start"),
      trigger("w-start"),
      ...(use ? [use] : []),
      output("w-stop"),
      output("canvas-stop"),
    ],
    wires: [
      wire("canvas-start", "out", "workspace-1", "flow-in"),
      ...chain(["w-start", ...ids(use), "w-stop"]),
      wire("workspace-1", "flow-out", "canvas-stop", "in"),
    ],
    containers: [workspaceContainer(["w-start", ...ids(use), "w-stop"])],
    settings: flowSettings,
  });

const looseInWorkflow = (use?: Use): Flow =>
  parseFlow({
    nodes: [
      trigger("canvas-start"),
      trigger("w-start"),
      ...(use ? [use] : []),
      output("w-stop"),
      output("canvas-stop"),
    ],
    wires: [
      wire("canvas-start", "out", "workspace-1", "flow-in"),
      thenWire("w-start", "w-stop"),
      ...(use === undefined
        ? [wire("workspace-1", "flow-out", "canvas-stop", "in")]
        : [wire("workspace-1", "flow-out", use.id, "in"), thenWire(use.id, "canvas-stop")]),
    ],
    containers: [workspaceContainer(["w-start", "w-stop"])],
    settings: flowSettings,
  });

const refusal = (
  place: (use?: Use) => Flow,
  libraryId: string,
  options: { libraries?: LibraryLookup; openFlowId?: string | null; label?: string } = {},
) =>
  libraryRefusal({
    before: place(),
    after: place(libraryNode(libraryId, options.label)),
    nodeId: "use",
    libraryId,
    libraries: options.libraries ?? lookup,
    openFlowId: options.openFlowId ?? null,
  });

const useReason = (place: (use?: Use) => Flow, libraryId: string): string => {
  const after = place(libraryNode(libraryId));
  const [problem] = libraryUse.check(after, { libraries: lookup });
  if (problem === undefined) throw new Error(`no library-use problem for ${libraryId}`);
  return reasonNaming(problem.node, problem.message, "Library");
};

describe("loopRefusal", () => {
  const uses = lookupOf({
    a: { name: "A", kind: "node-library", uses: ["b"] },
    b: { name: "B", kind: "node-library", uses: ["c"] },
    c: { name: "C", kind: "node-library" },
    d: { name: "D", kind: "node-library", uses: ["c"] },
  });

  it("names the open blueprint twice when it would use itself", () => {
    expect(loopRefusal(uses, "a", "a")).toBe(loopReason(["a", "a"], nameIn(uses)));
  });

  it("names the path back to the open blueprint through the libraries it uses", () => {
    expect(loopRefusal(uses, "c", "a")).toBe(loopReason(["c", "a", "b", "c"], nameIn(uses)));
  });

  it("allows a library other libraries also use", () => {
    expect(loopRefusal(uses, "d", "b")).toBeUndefined();
  });

  it("finds no loop back to a blueprint that is not open", () => {
    expect(loopRefusal(uses, null, "a")).toBeUndefined();
  });
});

describe("libraryRefusal", () => {
  it.each([
    ["a session library inside a session", inSession, "sessions"],
    ["a session library inside the workspace", inWorkspace, "sessions"],
    ["a node library loose in a workflow", looseInWorkflow, "nodes"],
    ["an incomplete blueprint", loose, "draft"],
    ["a workflow", loose, "flow"],
    ["a blueprint that does not exist", loose, "gone"],
  ])("refuses %s with the library-use reason", (_, place, libraryId) => {
    expect(refusal(place, libraryId)).toBe(useReason(place, libraryId));
  });

  it("refuses a loop before the library-use reason", () => {
    const libraries = lookupOf({ sessions: { name: "Session steps", kind: "session-library" } });

    expect(refusal(inSession, "sessions", { libraries, openFlowId: "sessions" })).toBe(
      loopReason(["sessions", "sessions"], nameIn(libraries)),
    );
  });

  it.each([
    ["a node library inside the workspace", inWorkspace, "nodes"],
    ["a node library loose in a blueprint with no workspace", loose, "nodes"],
    ["a node library inside a session", inSession, "nodes"],
    ["a session library loose in a workflow", looseInWorkflow, "sessions"],
    ["a session library loose in a blueprint with no workspace", loose, "sessions"],
  ])("allows %s", (_, place, libraryId) => {
    expect(refusal(place, libraryId, { openFlowId: "open" })).toBeUndefined();
  });

  it("leaves a label that cannot name a library to the validator", () => {
    const label = "android/app";

    expect(validate(loose(libraryNode("unsafe", label)), lookup).map(({ rule }) => rule)).toContain(
      "library-labels",
    );
    expect(refusal(loose, "unsafe", { label })).toBeUndefined();
  });
});
