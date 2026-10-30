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

  it("keeps the session frame's members", () => {
    const flow = flowWith({
      session: { ...session({ kind: "worktree", branch: "main" }), frame: { nodes: ["a", "b"] } },
    });

    expect(parseFlow(flow).session.frame).toEqual({ nodes: ["a", "b"] });
  });

  it.each(["/r", ""])("keeps a worktree folder's repo %j", (repo) => {
    const flow = flowWith({ session: session({ kind: "worktree", branch: "main", repo }) });

    expect(parseFlow(flow).session.workingFolder).toEqual({
      kind: "worktree",
      branch: "main",
      repo,
    });
  });

  it("adds no frame or repo key to a session that has neither", () => {
    const parsed = parseFlow(flowWith({}));

    expect(parsed.session).not.toHaveProperty("frame");
    expect(parsed.session.workingFolder).not.toHaveProperty("repo");
  });

  it("keeps a session budget", () => {
    const flow = flowWith({ session: { ...session({ kind: "path", path: "/r" }), budget: 1 } });

    expect(parseFlow(flow).session.budget).toBe(1);
  });

  it.each([0, -1, "1"])("rejects a session budget of %j at its path", (budget) => {
    const error = parseError(
      flowWith({ session: { ...session({ kind: "path", path: "/r" }), budget } }),
    );

    expect(error.issues.map((issue) => issue.path)).toContainEqual(["session", "budget"]);
  });

  it("adds no budget key to a session without one", () => {
    expect(parseFlow(flowWith({})).session).not.toHaveProperty("budget");
  });

  it("caps a loop at 3 rounds when it names no cap", () => {
    const loop = {
      id: "l",
      label: "L",
      position: { x: 0, y: 0 },
      type: "loop",
      settings: { condition: "tests pass", onCap: "fail" },
    };
    const parsed = parseFlow(flowWith({ nodes: [promptNode, loop] }));
    expect(parsed.nodes[1]?.settings).toEqual({ condition: "tests pass", cap: 3, onCap: "fail" });
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
