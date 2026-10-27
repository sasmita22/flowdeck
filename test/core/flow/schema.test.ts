import { describe, expect, it } from "vitest";
import { FlowParseError, NodeType, parseFlow } from "../../../src/core/flow/schema.js";

const session = (workingFolder: Record<string, unknown>) => ({
  name: "main",
  workingFolder,
  model: "sonnet",
  allowedTools: [],
  permissionMode: "default",
  connectors: [],
});

const promptNode = {
  id: "p",
  label: "P",
  position: { x: 0, y: 0 },
  type: "prompt",
  settings: { instructions: "Hi" },
};

const flowWith = (overrides: Record<string, unknown>) => ({
  nodes: [promptNode],
  wires: [],
  session: session({ kind: "worktree", branch: "main" }),
  ...overrides,
});

function parseError(input: unknown): FlowParseError {
  try {
    parseFlow(input);
  } catch (error) {
    expect(error).toBeInstanceOf(FlowParseError);
    return error as FlowParseError;
  }
  expect.fail("parseFlow accepted an invalid flow");
}

describe("parseFlow", () => {
  it.each([
    { kind: "worktree", branch: "main" },
    { kind: "path", path: "/tmp/repo" },
  ])("parses a minimal flow with a $kind working folder", (workingFolder) => {
    const flow = flowWith({ session: session(workingFolder) });
    expect(() => parseFlow(flow)).not.toThrow();
    expect(parseFlow(flow)).toEqual(flow);
  });

  it("names the field path of a bad loop cap", () => {
    const loop = {
      id: "l",
      label: "L",
      position: { x: 0, y: 0 },
      type: "loop",
      settings: { condition: "tests pass", cap: "three" },
    };
    const error = parseError(flowWith({ nodes: [promptNode, loop] }));
    expect(error.issues.map((issue) => issue.path)).toContainEqual(["nodes", 1, "settings", "cap"]);
    expect(error.message).toContain("settings.cap");
  });

  it("rejects an unknown node type at the node's path", () => {
    const error = parseError(flowWith({ nodes: [{ ...promptNode, type: "banana" }] }));
    expect(error.issues.map((issue) => issue.path.slice(0, 2))).toContainEqual(["nodes", 0]);
  });

  it("rejects a file wire without a file", () => {
    const wire = { kind: "file", from: { node: "p", port: "out" }, to: { node: "p", port: "in" } };
    const error = parseError(flowWith({ wires: [wire] }));
    expect(error.issues.map((issue) => issue.path)).toContainEqual(["wires", 0, "file"]);
  });

  it("lists the nine node types", () => {
    expect(NodeType.options).toEqual([
      "prompt",
      "script",
      "agent",
      "gate",
      "ask",
      "hardstop",
      "loop",
      "trigger",
      "output",
    ]);
  });
});
