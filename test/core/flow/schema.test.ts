import { describe, expect, it } from "vitest";
import { FlowParseError, NodeType, parseFlow } from "../../../src/core/flow/schema.js";
import { forEach } from "../../fixtures/flow-builders.js";

const sessionBase = {
  name: "main",
  model: "sonnet",
  allowedTools: [],
  permissionMode: "default",
  connectors: [],
};

const session = (buildConfig: Record<string, unknown> = { base: "main", variables: [] }) => ({
  ...sessionBase,
  buildConfig,
});

const promptNode = {
  id: "p",
  label: "P",
  position: { x: 0, y: 0 },
  type: "prompt",
  settings: { instructions: "Hi" },
};

const triggerNode = (settings: Record<string, unknown>) => ({
  id: "start",
  label: "Start",
  position: { x: 0, y: 0 },
  type: "trigger",
  settings,
});

const branchNode = (settings: Record<string, unknown>) => ({
  id: "b",
  label: "E2E?",
  position: { x: 0, y: 0 },
  type: "branch",
  settings,
});

const flowWith = (overrides: Record<string, unknown>) => ({
  nodes: [promptNode],
  wires: [],
  session: session(),
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
  it("parses a minimal flow with a Build configuration", () => {
    const flow = flowWith({
      session: session({
        repo: "/tmp/repo",
        base: "main",
        variables: [
          { name: "ticket", kind: "text" },
          { name: "e2e", kind: "yesno", default: true },
          { name: "env", kind: "text", default: "staging" },
        ],
      }),
    });

    expect(parseFlow(flow)).toEqual(flow);
  });

  it("keeps the session frame's members", () => {
    const flow = flowWith({ session: { ...session(), frame: { nodes: ["a", "b"] } } });

    expect(parseFlow(flow).session.frame).toEqual({ nodes: ["a", "b"] });
  });

  it.each(["/r", ""])("keeps a Build configuration's repo %j", (repo) => {
    const flow = flowWith({ session: session({ repo, base: "main", variables: [] }) });

    expect(parseFlow(flow).session.buildConfig).toEqual({ repo, base: "main", variables: [] });
  });

  it("gives a Build configuration with no variables an empty list", () => {
    expect(parseFlow(flowWith({ session: session({ base: "main" }) })).session.buildConfig).toEqual(
      { base: "main", variables: [] },
    );
  });

  it("parses a Build configuration with no repo and no base, adding neither key", () => {
    const { buildConfig } = parseFlow(flowWith({ session: session({ variables: [] }) })).session;

    expect(buildConfig).toEqual({ variables: [] });
    expect(buildConfig).not.toHaveProperty("repo");
    expect(buildConfig).not.toHaveProperty("base");
  });

  it("adds no frame key to a session that has none", () => {
    expect(parseFlow(flowWith({})).session).not.toHaveProperty("frame");
  });

  it("moves an old blueprint's Trigger inputs, flags and worktree folder into the Build configuration", () => {
    const old = {
      nodes: [
        triggerNode({ inputs: ["ticket"], flags: { e2e: true } }),
        branchNode({ flag: "e2e" }),
      ],
      wires: [],
      session: { ...sessionBase, workingFolder: { kind: "worktree", branch: "dev", repo: "/r" } },
    };

    const parsed = parseFlow(old);

    expect(parsed.session.buildConfig).toEqual({
      repo: "/r",
      base: "dev",
      variables: expect.arrayContaining([
        { name: "ticket", kind: "text" },
        { name: "e2e", kind: "yesno", default: true },
      ]) as unknown,
    });
    expect(parsed.session.buildConfig.variables).toHaveLength(2);
    expect(parsed.session).not.toHaveProperty("workingFolder");
    expect(parsed.nodes[0]?.settings).toEqual({});
    expect(parsed.nodes[1]?.settings).toEqual({ variable: "e2e" });
  });

  it("parses a Trigger with no inputs or flags", () => {
    const flow = flowWith({ nodes: [triggerNode({}), promptNode] });

    expect(parseFlow(flow)).toEqual(flow);
  });

  it("keeps a session budget", () => {
    const flow = flowWith({ session: { ...session(), budget: 1 } });

    expect(parseFlow(flow).session.budget).toBe(1);
  });

  it.each([0, -1, "1"])("rejects a session budget of %j at its path", (budget) => {
    const error = parseError(flowWith({ session: { ...session(), budget } }));

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

  it("parses a fork and a join", () => {
    const fork = {
      id: "f",
      label: "F",
      position: { x: 0, y: 0 },
      type: "fork",
      settings: {},
    };
    const join = {
      id: "j",
      label: "J",
      position: { x: 0, y: 0 },
      type: "join",
      settings: { wait: "first", onBranchFail: "skip" },
    };
    const flow = flowWith({ nodes: [promptNode, fork, join] });

    expect(parseFlow(flow)).toEqual(flow);
  });

  it("parses a for each with a prompt in its body", () => {
    const flow = flowWith({ nodes: [forEach("e1"), { ...promptNode, parent: "e1" }] });

    expect(parseFlow(flow)).toEqual(flow);
  });

  it("names the field path of an absolute for each file", () => {
    const error = parseError(flowWith({ nodes: [promptNode, forEach("e1", { file: "/abs.md" })] }));
    expect(error.issues.map((issue) => issue.path)).toContainEqual([
      "nodes",
      1,
      "settings",
      "file",
    ]);
  });

  it("parses a branch on a variable", () => {
    const flow = flowWith({ nodes: [promptNode, branchNode({ variable: "e2e" })] });

    expect(parseFlow(flow)).toEqual(flow);
  });

  it("parses a branch with the old flag key into a branch on the variable", () => {
    const parsed = parseFlow(flowWith({ nodes: [promptNode, branchNode({ flag: "e2e" })] }));

    expect(parsed.nodes[1]?.settings).toEqual({ variable: "e2e" });
  });

  it("lists the thirteen node types", () => {
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
      "fork",
      "join",
      "foreach",
      "branch",
    ]);
  });
});

describe("notes", () => {
  const note = {
    id: "n1",
    text: "Explains the flow",
    position: { x: 10, y: 20 },
    size: { width: 200, height: 120 },
  };

  it("keeps a flow's notes exactly", () => {
    const flow = flowWith({ notes: [note] });

    expect(parseFlow(flow)).toEqual(flow);
  });

  it("adds no notes key to a flow without notes", () => {
    expect(parseFlow(flowWith({}))).not.toHaveProperty("notes");
  });

  it("keeps an empty note text", () => {
    expect(parseFlow(flowWith({ notes: [{ ...note, text: "" }] })).notes?.[0]?.text).toBe("");
  });

  it.each([
    ["an empty id", { ...note, id: "" }, ["notes", 0, "id"]],
    ["a zero width", { ...note, size: { width: 0, height: 120 } }, ["notes", 0, "size", "width"]],
    ["no position", { id: "n1", text: "", size: note.size }, ["notes", 0, "position"]],
  ])("rejects a note with %s at its path", (_name, bad, path) => {
    expect(parseError(flowWith({ notes: [bad] })).issues[0]?.path).toEqual(path);
  });
});
