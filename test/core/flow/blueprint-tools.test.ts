import { describe, expect, it } from "vitest";
import {
  blueprintToolDefinitions,
  canvasToolNames,
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
  "list_builds",
  "read_build",
  "tidy_layout",
  "add_connection",
  "delete_connection",
];

const editToolNames = [
  "add_node",
  "change_node",
  "wire",
  "delete_node",
  "tidy_layout",
  "add_connection",
  "delete_connection",
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
  it("tells the model add_node's parent can be a Loop, a For each or a container", () => {
    const tool = definition("add_node");
    const [input] = inputBranches("add_node");
    const parent = input?.properties?.["parent"] as { description?: string } | undefined;

    expect(tool.description).toMatch(/container/i);
    expect(parent?.description).toMatch(/container/i);
    expect(parent?.description).toMatch(/loop/i);
  });

  it("offers exactly the twelve blueprint tools and nothing that builds, runs or deletes a build", () => {
    const names = blueprintToolDefinitions().map((tool) => tool.name);

    expect([...names].sort()).toEqual([...toolNames].sort());
    expect(names).toHaveLength(12);
    expect(names).not.toContain("set_variable");
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

  it("requires two session ids to add a connection and a connection id to delete one", () => {
    const [add] = inputBranches("add_connection");
    const between = add?.properties?.["between"] as
      | { type?: string; minItems?: number; maxItems?: number; prefixItems?: JsonSchema[] }
      | undefined;

    expect(add?.required).toEqual(["between"]);
    expect(between?.type).toBe("array");
    expect(between?.prefixItems?.map(({ type }) => type)).toEqual(["string", "string"]);
    expect(inputBranches("delete_connection")[0]?.required).toEqual(["connectionId"]);
    expect(inputBranches("delete_connection")[0]?.properties?.["connectionId"]?.type).toBe(
      "string",
    );
  });

  it.each(["add_connection", "delete_connection"])("lets the canvas take %s", (name) => {
    expect(canvasToolNames.has(name)).toBe(true);
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

  it("lets add_node take a library node with its libraryId in settings", () => {
    const [branch] = inputBranches("add_node");
    const types = (branch?.properties?.type as { enum?: string[] } | undefined)?.enum ?? [];
    const input = { type: "library", label: "Lib", settings: { libraryId: "flow-lib" } };

    expect(types).toContain("library");
    expect(toolInputs.add_node.safeParse(input)).toEqual({ success: true, data: input });
  });

  it("says add_node takes a library's libraryId in settings and derives its label", () => {
    const { description } = definition("add_node");

    expect(description).toMatch(/libraryId.*settings/i);
    expect(description).toMatch(/label.*ignored|ignores.*label/i);
    expect(description).toMatch(/canvas/i);
  });

  it("says a new libraryId in change_node re-derives the label and clears the old library's overrides", () => {
    const { description } = definition("change_node");

    expect(description).toMatch(/libraryId/);
    expect(description).toMatch(/label/i);
    expect(description).toMatch(/overrides/i);
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

  it.each(["list_blueprints", "search_blueprints"])(
    "says %s leaves deleted blueprints out",
    (name) => {
      expect(definition(name).description).toMatch(/deleted blueprints are left out/i);
    },
  );

  it("says read_blueprint of a deleted blueprint answers that it was deleted", () => {
    expect(definition("read_blueprint").description).toMatch(/deleted.*answers.*was deleted/i);
  });

  it("says read_blueprint reads the blueprint's containers, not a single session", () => {
    const { description } = definition("read_blueprint");

    expect(description).toMatch(/containers/i);
    expect(description).not.toMatch(/\bsession\b(?! containers?)/i);
  });

  it("says read_blueprint reads the blueprint's connections", () => {
    expect(definition("read_blueprint").description).toMatch(/\bconnections\b/);
  });

  it("keeps the wire tool to then and event wires between node ports", () => {
    const { description, inputSchema } = definition("wire");

    expect(description).toBe("Connect an output port of one node to an input port of another.");
    expect(inputSchema).toEqual({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        kind: { type: "string", enum: ["then", "event"] },
        from: {
          type: "object",
          properties: { node: { type: "string" }, port: { type: "string" } },
          required: ["node", "port"],
        },
        to: {
          type: "object",
          properties: { node: { type: "string" }, port: { type: "string" } },
          required: ["node", "port"],
        },
      },
      required: ["kind", "from", "to"],
      additionalProperties: false,
    });
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
