import { describe, expect, it } from "vitest";
import { rule } from "../../../../src/core/compiler/rules/outside-container.js";
import {
  agent,
  flow,
  flowSettings,
  loop,
  output,
  sessionContainer,
  thenWire,
  trigger,
  workspaceContainer,
} from "../../../fixtures/flow-builders.js";
import { libraryOf } from "../../../fixtures/known-library.js";

const workspaceNodes = [trigger("workspace-start"), output("workspace-stop")];
const workspaceWire = thenWire("workspace-start", "workspace-stop");
const workspace = workspaceContainer(["workspace-start", "workspace-stop"]);
const sessionNodes = [trigger("start"), agent("a"), output("stop")];
const sessionWires = [thenWire("start", "a"), thenWire("a", "stop")];
const session = sessionContainer(["start", "a", "stop"]);

const errorsOf = (input: ReturnType<typeof flow>) =>
  rule.check(input).map(({ rule, node }) => ({ rule, node }));

describe("outside-container", () => {
  it("refuses a top-level node in no container of a workflow, naming it", () => {
    const stray = flow(
      [...workspaceNodes, ...sessionNodes, agent("x")],
      [workspaceWire, ...sessionWires],
      flowSettings,
      { containers: [workspace, session] },
    );

    expect(errorsOf(stray)).toEqual([{ rule: "outside-container", node: "x" }]);
  });

  it("accepts a body node inside a member loop", () => {
    const withLoop = flow(
      [...workspaceNodes, trigger("start"), loop("L"), agent("x", { parent: "L" }), output("stop")],
      [workspaceWire, thenWire("start", "L"), thenWire("L", "stop")],
      flowSettings,
      { containers: [workspace, sessionContainer(["start", "L", "stop"])] },
    );

    expect(rule.check(withLoop)).toEqual([]);
  });

  it("accepts a node in no container of a library", () => {
    const library = flow([...sessionNodes, agent("x")], sessionWires, flowSettings, {
      containers: [session],
    });

    expect(rule.check(library)).toEqual([]);
  });

  const libraries = libraryOf({ nodes: "node-library", sessions: "session-library" });

  const libraryNode = (id: string, libraryId: string) => ({
    id,
    type: "library",
    label: `Use ${libraryId}`,
    position: { x: 0, y: 0 },
    settings: { libraryId, label: libraryId, overrides: {} },
  });

  it.each([
    ["an Agent", agent("x"), ["x is outside every workspace and session; move it into one."]],
    [
      "a node library",
      libraryNode("x", "nodes"),
      ["Use nodes is outside every workspace and session; move it into one."],
    ],
    ["a session library", libraryNode("x", "sessions"), []],
  ])("answers %s loose in a workflow", (_, loose, messages) => {
    const withLoose = flow(
      [...workspaceNodes, ...sessionNodes, loose],
      [workspaceWire, ...sessionWires],
      flowSettings,
      { containers: [workspace, session] },
    );

    expect(rule.check(withLoose, { libraries }).map(({ message }) => message)).toEqual(messages);
  });
});
