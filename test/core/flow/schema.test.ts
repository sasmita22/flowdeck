import { describe, expect, it } from "vitest";
import {
  FlowParseError,
  NodeType,
  parseFlow,
  Wire,
  WireKind,
} from "../../../src/core/flow/schema.js";
import { agent, fileWire, thenWire } from "../../fixtures/flow-builders.js";

const workspace = { id: "workspace-1", kind: "workspace", model: "sonnet", nodes: [] };

const sessionContainer = (overrides: Record<string, unknown> = {}) => ({
  id: "session-1",
  kind: "session",
  name: "main",
  repo: "/tmp/repo",
  branch: "main",
  model: "sonnet",
  nodes: ["p"],
  ...overrides,
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
  containers: [workspace, sessionContainer()],
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
  it("parses a minimal flow with a workspace and a session container", () => {
    const flow = flowWith({});

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

  it("keeps one workspace and two session containers with every field", () => {
    const containers = [
      { ...workspace, model: "opus", nodes: ["workspace-1-start", "workspace-1-stop"] },
      sessionContainer({ nodes: ["p", "q"] }),
      sessionContainer({
        id: "session-2",
        name: "review",
        repo: "/r/shop",
        branch: "dev",
        model: "haiku",
        nodes: ["r"],
      }),
    ];

    expect(parseFlow(flowWith({ containers })).containers).toEqual(containers);
  });

  it("parses a session container with no repo, leaving the empty repo to validation", () => {
    const containers = [sessionContainer({ repo: "" })];

    expect(parseFlow(flowWith({ containers })).containers).toEqual(containers);
  });

  it("refuses a flow with a session and no containers", () => {
    const old = flowWith({
      containers: undefined,
      session: { name: "main", buildConfig: { repo: "/r", base: "main" }, model: "sonnet" },
    });

    expect(parseError(old).issues.map((issue) => issue.path)).toContainEqual(["containers"]);
  });

  it("refuses a container of an unknown kind at its path", () => {
    const containers = [{ ...workspace, kind: "group" }];

    expect(
      parseError(flowWith({ containers })).issues.map((issue) => issue.path.slice(0, 2)),
    ).toContainEqual(["containers", 0]);
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

  it("rejects a foreach node with an error at its type that offers no foreach", () => {
    const error = parseError(
      flowWith({ nodes: [{ ...agentNode, type: "foreach", settings: { file: "items.txt" } }] }),
    );

    expect(error.message).toContain("nodes[0].type");
    expect(error.message).not.toContain("foreach");
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

  it.each([
    ["an Always Gate", { stopWhen: "always", condition: "", instruction: "Check the plan" }],
    ["a Conditional Gate", { stopWhen: "conditional", condition: "tests fail", instruction: "" }],
    [
      "a Conditional Gate with no condition yet",
      { stopWhen: "conditional", condition: "", instruction: "" },
    ],
  ])("parses %s", (_, gateSettings) => {
    const flow = flowWith({
      nodes: [agentNode, { ...agentNode, id: "g", type: "gate", settings: gateSettings }],
    });

    expect(parseFlow(flow)).toEqual(flow);
  });

  it("rejects a Gate with the old settings", () => {
    const error = parseError(
      flowWith({
        nodes: [{ ...agentNode, type: "gate", settings: { shown: "", skippable: true } }],
      }),
    );

    expect(error.issues.map((issue) => issue.path.slice(0, 2))).toContainEqual(["nodes", 0]);
  });

  it.each([
    ["ask", { question: "Pick a colour", options: ["red"] }],
    ["hardstop", { condition: "tests fail", shown: "", locked: true, enabled: true }],
  ])("rejects a removed %s node", (type, settings) => {
    const error = parseError(flowWith({ nodes: [{ ...agentNode, type, settings }] }));

    expect(error.issues.map((issue) => issue.path.slice(0, 2))).toContainEqual(["nodes", 0]);
  });

  it("lists the nine node types", () => {
    expect(NodeType.options).toEqual([
      "agent",
      "gate",
      "loop",
      "trigger",
      "output",
      "fork",
      "join",
      "branch",
      "library",
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
      containers: [workspace, sessionContainer({ nodes: ["start", "b", "plan", "build"] })],
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

describe("connections", () => {
  const connection = { id: "c1", between: ["s-android", "s-ios"] };

  it("keeps a flow's connections exactly", () => {
    const flow = flowWith({ connections: [connection] });

    expect(parseFlow(flow)).toEqual(flow);
  });

  it("adds no connections key to a flow without connections", () => {
    expect(parseFlow(flowWith({}))).not.toHaveProperty("connections");
  });

  it.each([
    ["no id", { between: connection.between }, ["connections", 0, "id"]],
    ["one end", { id: "c1", between: ["s-android"] }, ["connections", 0, "between"]],
    ["three ends", { id: "c1", between: ["a", "b", "c"] }, ["connections", 0, "between"]],
    ["a number end", { id: "c1", between: ["s-android", 2] }, ["connections", 0, "between", 1]],
  ])("rejects a connection with %s at its path", (_name, bad, path) => {
    expect(parseError(flowWith({ connections: [bad] })).issues[0]?.path).toEqual(path);
  });
});
