import { describe, expect, it } from "vitest";
import {
  FlowParseError,
  NodeType,
  parseFlow,
  Wire,
  WireKind,
} from "../../../src/core/flow/schema.js";
import { agent, fileWire, forEach, thenWire } from "../../fixtures/flow-builders.js";

const sessionBase = { name: "main", model: "sonnet" };

const session = (buildConfig: Record<string, unknown> = { base: "main" }) => ({
  ...sessionBase,
  buildConfig,
});

const settings = { buildModel: "opus", permissionMode: "acceptEdits" };

const agentNode = {
  id: "p",
  label: "P",
  position: { x: 0, y: 0 },
  type: "agent",
  settings: { role: "", instructions: "Hi", model: "sonnet" },
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
  nodes: [agentNode],
  wires: [],
  session: session(),
  settings,
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
    const flow = flowWith({ session: session({ repo: "/tmp/repo", base: "main" }) });

    expect(parseFlow(flow)).toEqual(flow);
  });

  it("keeps the blueprint's build model and permission mode", () => {
    expect(parseFlow(flowWith({})).settings).toEqual({
      buildModel: "opus",
      permissionMode: "acceptEdits",
    });
  });

  it("refuses a flow with no settings at its path", () => {
    expect(
      parseError(flowWith({ settings: undefined })).issues.map((issue) => issue.path),
    ).toContainEqual(["settings"]);
  });

  it("keeps the repository, branch and model on the session and nothing removed", () => {
    const parsed = parseFlow(
      flowWith({
        session: {
          ...sessionBase,
          buildConfig: { repo: "/r", base: "dev", variables: [], buildModel: "haiku" },
          allowedTools: ["Bash"],
          connectors: ["github"],
          budget: 1,
          permissionMode: "plan",
        },
      }),
    );

    expect(parsed.session).toEqual({
      name: "main",
      model: "sonnet",
      buildConfig: { repo: "/r", base: "dev" },
    });
  });

  it("keeps the session frame's members", () => {
    const flow = flowWith({ session: { ...session(), frame: { nodes: ["a", "b"] } } });

    expect(parseFlow(flow).session.frame).toEqual({ nodes: ["a", "b"] });
  });

  it.each(["/r", ""])("keeps a Build configuration's repo %j", (repo) => {
    const flow = flowWith({ session: session({ repo, base: "main" }) });

    expect(parseFlow(flow).session.buildConfig).toEqual({ repo, base: "main" });
  });

  it("parses a Build configuration with no repo and no base, adding neither key", () => {
    const { buildConfig } = parseFlow(flowWith({ session: session({}) })).session;

    expect(buildConfig).toEqual({});
    expect(buildConfig).not.toHaveProperty("repo");
    expect(buildConfig).not.toHaveProperty("base");
  });

  it("adds no frame key to a session that has none", () => {
    expect(parseFlow(flowWith({})).session).not.toHaveProperty("frame");
  });

  it("parses a Trigger with no inputs or flags", () => {
    const flow = flowWith({ nodes: [triggerNode({}), agentNode] });

    expect(parseFlow(flow)).toEqual(flow);
  });

  it("caps a loop at 3 rounds when it names no cap", () => {
    const loop = {
      id: "l",
      label: "L",
      position: { x: 0, y: 0 },
      type: "loop",
      settings: { condition: "tests pass", onCap: "fail" },
    };
    const parsed = parseFlow(flowWith({ nodes: [agentNode, loop] }));
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
    const error = parseError(flowWith({ nodes: [agentNode, loop] }));
    expect(error.issues.map((issue) => issue.path)).toContainEqual(["nodes", 1, "settings", "cap"]);
    expect(error.message).toContain("settings.cap");
  });

  it("rejects an unknown node type at the node's path", () => {
    const error = parseError(flowWith({ nodes: [{ ...agentNode, type: "banana" }] }));
    expect(error.issues.map((issue) => issue.path.slice(0, 2))).toContainEqual(["nodes", 0]);
  });

  it("has Then and Event wires only", () => {
    expect(WireKind.options).toEqual(["then", "event"]);
  });

  it("refuses a File wire", () => {
    const wire = {
      kind: "file",
      file: "plan.md",
      from: { node: "p", port: "file-out" },
      to: { node: "q", port: "file-in" },
    };
    expect(Wire.safeParse(wire).success).toBe(false);
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
    const flow = flowWith({ nodes: [agentNode, fork, join] });

    expect(parseFlow(flow)).toEqual(flow);
  });

  it("parses a for each with an agent in its body", () => {
    const flow = flowWith({ nodes: [forEach("e1"), { ...agentNode, parent: "e1" }] });

    expect(parseFlow(flow)).toEqual(flow);
  });

  it("names the field path of an absolute for each file", () => {
    const error = parseError(flowWith({ nodes: [agentNode, forEach("e1", { file: "/abs.md" })] }));
    expect(error.issues.map((issue) => issue.path)).toContainEqual([
      "nodes",
      1,
      "settings",
      "file",
    ]);
  });

  it("parses a branch on a variable", () => {
    const flow = flowWith({ nodes: [agentNode, branchNode({ variable: "e2e" })] });

    expect(parseFlow(flow)).toEqual(flow);
  });

  it.each([
    ["prompt", { instructions: "Hi" }],
    ["script", { command: "npm" }],
  ])("rejects a %s node at the node's path", (type, settings) => {
    const error = parseError(flowWith({ nodes: [{ ...agentNode, type, settings }] }));
    expect(error.issues.map((issue) => issue.path.slice(0, 2))).toContainEqual(["nodes", 0]);
  });

  it("lists the eleven node types", () => {
    expect(NodeType.options).toEqual([
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

describe("parseFlow on a blueprint in the current shape", () => {
  it("parses it unchanged", () => {
    const current = {
      nodes: [
        triggerNode({}),
        branchNode({ variable: "e2e" }),
        agent("plan", { settings: { instructions: "Fix {{ticket}}", writes: ["plan.md"] } }),
        agent("build", { settings: { given: ["plan.md"] } }),
      ],
      wires: [thenWire("plan", "build")],
      session: session(),
      settings,
    };

    expect(parseFlow(structuredClone(current))).toEqual(current);
  });
});

describe("parseFlow on a blueprint in an old shape", () => {
  const refusedAt = (input: unknown) =>
    parseError(input).issues.map((issue) => issue.path.slice(0, 2));

  it("refuses a File wire instead of turning it into Agent files", () => {
    const old = flowWith({
      nodes: [agent("plan"), agent("build")],
      wires: [thenWire("plan", "build"), fileWire("plan", "build", "plan.md")],
    });

    expect(refusedAt(old)).toContainEqual(["wires", 1]);
  });

  it("refuses a session with a working folder instead of moving it to a Build configuration", () => {
    const old = flowWith({
      nodes: [triggerNode({})],
      session: { ...sessionBase, workingFolder: { kind: "worktree", branch: "dev" } },
    });

    expect(refusedAt(old)).toContainEqual(["session", "buildConfig"]);
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
