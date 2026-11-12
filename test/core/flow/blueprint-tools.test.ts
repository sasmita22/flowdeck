import { describe, expect, it } from "vitest";
import {
  blueprintToolDefinitions,
  searchBlueprints,
  socketLineSchema,
  toolAnswerSchema,
  toolCallSchema,
  toolInputs,
} from "../../../src/core/flow/blueprint-tools.js";
import { agent, flow, trigger } from "../../fixtures/flow-builders.js";

type JsonSchema = {
  type?: string;
  properties?: Record<string, { type?: string }>;
  required?: string[];
  additionalProperties?: unknown;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
};

const toolNames = [
  "list_blueprints",
  "search_blueprints",
  "read_blueprint",
  "add_node",
  "change_node",
  "wire",
  "delete_node",
  "set_variable",
  "list_builds",
  "read_build",
  "tidy_layout",
];

const editToolNames = [
  "add_node",
  "change_node",
  "wire",
  "delete_node",
  "set_variable",
  "tidy_layout",
];

const definition = (name: string) => {
  const found = blueprintToolDefinitions().find((tool) => tool.name === name);
  if (found === undefined) expect.fail(`no tool named ${name}`);
  return found;
};

const objectBranches = (schema: JsonSchema): JsonSchema[] => {
  const options = schema.anyOf ?? schema.oneOf;
  return options === undefined ? [schema] : options.flatMap(objectBranches);
};

const inputBranches = (name: string) => objectBranches(definition(name).inputSchema as JsonSchema);

describe("blueprintToolDefinitions", () => {
  it("offers exactly the eleven blueprint tools and nothing that builds, runs or deletes a build", () => {
    const names = blueprintToolDefinitions().map((tool) => tool.name);

    expect([...names].sort()).toEqual([...toolNames].sort());
  });

  it("gives every tool a description and a JSON input schema", () => {
    for (const tool of blueprintToolDefinitions()) {
      expect(tool.description, tool.name).toEqual(expect.stringMatching(/\S/));
      expect(inputBranches(tool.name).length, tool.name).toBeGreaterThan(0);
      for (const branch of inputBranches(tool.name)) {
        expect(branch.type, tool.name).toBe("object");
      }
    }
  });

  it.each(toolNames)(
    "gives %s a top-level object input schema, the shape MCP clients accept",
    (name) => {
      const schema = definition(name).inputSchema as JsonSchema & {
        allOf?: JsonSchema[];
      };

      expect(schema.type).toBe("object");
      expect(schema.properties).toEqual(expect.any(Object));
      expect(schema).not.toHaveProperty("oneOf");
      expect(schema).not.toHaveProperty("anyOf");
      expect(schema).not.toHaveProperty("allOf");
    },
  );

  it("requires the fields each lookup and node tool needs", () => {
    expect(inputBranches("search_blueprints")[0]?.required).toContain("query");
    expect(inputBranches("read_build")[0]?.required).toContain("id");
    expect(inputBranches("delete_node")[0]?.required).toContain("nodeId");
    expect(inputBranches("change_node")[0]?.required).toContain("nodeId");
  });

  it("lets set_variable name and type a variable but never touch the repo or base branch", () => {
    for (const branch of inputBranches("set_variable")) {
      const fields = Object.keys(branch.properties ?? {});
      expect(fields).toEqual(expect.arrayContaining(["name", "kind"]));
      expect(fields).not.toContain("repo");
      expect(fields).not.toContain("base");
    }
  });

  it.each(editToolNames)("gives %s no blueprint argument and refuses extra keys", (name) => {
    for (const branch of inputBranches(name)) {
      expect(branch.properties).not.toHaveProperty("blueprint");
      expect(branch.additionalProperties).toBe(false);
    }
  });

  it.each(["prompt", "script"])("refuses to add a %s node", (type) => {
    expect(toolInputs.add_node.safeParse({ type, label: "Old" }).success).toBe(false);
  });

  it("offers Agent among the node types add_node takes, and no Prompt or Script", () => {
    const add = definition("add_node");
    const [branch] = inputBranches("add_node");
    const types = (branch?.properties?.type as { enum?: string[] } | undefined)?.enum ?? [];

    expect(types).toContain("agent");
    expect(types).not.toEqual(expect.arrayContaining(["prompt"]));
    expect(types).not.toEqual(expect.arrayContaining(["script"]));
    expect(add.description).not.toMatch(/prompt|script/i);
  });

  it.each(["then", "event"])("lets wire take a %s wire", (kind) => {
    const input = { kind, from: { node: "a1", port: "out" }, to: { node: "p1", port: "in" } };
    expect(toolInputs.wire.safeParse(input).success).toBe(true);
  });

  it("refuses a File wire and never mentions one in the wire tool", () => {
    const fileWire = {
      kind: "file",
      file: "plan.md",
      from: { node: "a1", port: "file-out" },
      to: { node: "p1", port: "file-in" },
    };
    const [branch] = inputBranches("wire");

    expect(toolInputs.wire.safeParse(fileWire).success).toBe(false);
    expect(branch?.properties).not.toHaveProperty("file");
    expect(JSON.stringify(definition("wire"))).not.toMatch(/file/i);
  });

  it("tells the agent to tidy the layout as the last edit of an ask that added nodes or wires, then check", () => {
    const { description } = definition("tidy_layout");

    expect(description).toMatch(/last edit/i);
    expect(description).toMatch(/nodes or wires/i);
    expect(description).toMatch(/then check/i);
  });

  it("lets read_blueprint name a blueprint, optionally", () => {
    const [branch] = inputBranches("read_blueprint");
    expect(branch?.properties?.blueprint?.type).toBe("string");
    expect(branch?.required ?? []).not.toContain("blueprint");
  });
});

describe("socketLineSchema", () => {
  it("parses a tools request", () => {
    const line = { type: "tools", session: "fd-bp-flow-1" };

    expect(socketLineSchema.safeParse(line)).toEqual({ success: true, data: line });
  });

  it("parses a tool call", () => {
    const line = {
      type: "call",
      session: "fd-bp-flow-1",
      name: "delete_node",
      input: { nodeId: "a1" },
    };

    expect(socketLineSchema.safeParse(line)).toEqual({ success: true, data: line });
  });

  it.each([
    ["an unknown type", { type: "build", session: "fd-bp-flow-1" }],
    ["a tools request without a session", { type: "tools" }],
    ["a call without a name", { type: "call", session: "fd-bp-flow-1", input: {} }],
    ["something that is not an object", "tools"],
  ])("rejects %s", (_, line) => {
    expect(socketLineSchema.safeParse(line).success).toBe(false);
  });
});

describe("toolCallSchema", () => {
  it("parses a call relayed with its request id", () => {
    const call = {
      requestId: "r-1",
      session: "fd-bp-flow-1",
      name: "add_node",
      input: { type: "agent" },
    };

    expect(toolCallSchema.safeParse(call)).toEqual({ success: true, data: call });
  });

  it("rejects a call without a request id", () => {
    const call = { session: "fd-bp-flow-1", name: "add_node", input: {} };

    expect(toolCallSchema.safeParse(call).success).toBe(false);
  });
});

describe("toolAnswerSchema", () => {
  it("parses an answer matched to its request id", () => {
    const answer = { requestId: "r-1", result: { ok: true, nodeId: "n1", problems: [] } };

    expect(toolAnswerSchema.safeParse(answer)).toEqual({ success: true, data: answer });
  });

  it("rejects an answer without a request id", () => {
    expect(toolAnswerSchema.safeParse({ result: { ok: true } }).success).toBe(false);
  });
});

describe("searchBlueprints", () => {
  const entries = [
    {
      flowId: "f-review",
      name: "Code Review",
      version: 1,
      flow: flow([trigger("start"), agent("p1")], []),
    },
    {
      flowId: "f-ship",
      name: "Ship it",
      version: 2,
      flow: flow([trigger("start"), { ...agent("a1"), label: "The Planner" }], []),
    },
  ];

  const ids = (query: string) => searchBlueprints(entries, query).map((entry) => entry.flowId);

  it("finds a blueprint by a case-insensitive part of its name", () => {
    expect(ids("REVIEW")).toEqual(["f-review"]);
  });

  it("finds a blueprint by a case-insensitive part of a node label", () => {
    expect(ids("planner")).toEqual(["f-ship"]);
  });

  it("returns an empty list when nothing matches", () => {
    expect(ids("deploy")).toEqual([]);
  });
});
