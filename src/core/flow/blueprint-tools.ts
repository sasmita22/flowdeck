import { z } from "zod";
import type { LoadedFlow } from "./flow-store.js";
import { NodeType, Variable, Wire, WireKind } from "./schema.js";

const target = {
  blueprint: z
    .string()
    .optional()
    .describe("The flow id of the blueprint to work on. Leave it out for the open blueprint."),
};

const partialSettings = z.record(z.string(), z.unknown());

const [thenWire, fileWire] = Wire.options;
const [textVariable, yesnoVariable] = Variable.options;

export const toolInputs = {
  list_blueprints: z.object({}),
  search_blueprints: z.object({ query: z.string() }),
  read_blueprint: z.object(target),
  add_node: z.object({
    type: NodeType,
    label: z.string(),
    parent: z.string().optional(),
    settings: partialSettings.default({}),
    ...target,
  }),
  change_node: z.object({
    nodeId: z.string(),
    label: z.string().optional(),
    settings: partialSettings.optional(),
    ...target,
  }),
  wire: thenWire.extend({
    kind: WireKind,
    file: fileWire.shape.file.optional().describe("The file a file wire carries."),
    ...target,
  }),
  delete_node: z.object({ nodeId: z.string(), ...target }),
  set_variable: textVariable.extend({
    kind: z.enum([textVariable.shape.kind.value, yesnoVariable.shape.kind.value]),
    default: z
      .union([textVariable.shape.default.unwrap(), yesnoVariable.shape.default.unwrap()])
      .optional(),
    ...target,
  }),
  list_builds: z.object({}),
  read_build: z.object({ id: z.string() }),
};

export type ToolName = keyof typeof toolInputs;

const descriptions: Record<ToolName, string> = {
  list_blueprints: "List every saved blueprint.",
  search_blueprints: "Find blueprints whose name or any node label contains the query.",
  read_blueprint: "Read a blueprint's nodes, wires, session and current problems.",
  add_node:
    "Add a node to a blueprint. The settings given are merged over the node type's defaults.",
  change_node: "Change a node's label or some of its settings.",
  wire: "Connect an output port of one node to an input port of another.",
  delete_node: "Delete a node and its wires.",
  set_variable: "Add a build variable, or change the one with the same name.",
  list_builds: "List the builds made from blueprints.",
  read_build: "Read one build.",
};

export const toolNames = Object.keys(toolInputs) as ToolName[];

export const buildToolNames: ReadonlySet<string> = new Set<ToolName>(["list_builds", "read_build"]);

export const canvasToolNames: ReadonlySet<string> = new Set(
  toolNames.filter((name) => !buildToolNames.has(name)),
);

export type ToolDefinition = { name: ToolName; description: string; inputSchema: unknown };

export function blueprintToolDefinitions(): ToolDefinition[] {
  return toolNames.map((name) => ({
    name,
    description: descriptions[name],
    inputSchema: z.toJSONSchema(toolInputs[name], { io: "input" }),
  }));
}

export const socketLineSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("tools"), session: z.string() }),
  z.object({ type: z.literal("call"), session: z.string(), name: z.string(), input: z.unknown() }),
]);

export const toolCallSchema = z.object({
  requestId: z.string(),
  session: z.string(),
  name: z.string(),
  input: z.unknown(),
});

export const toolAnswerSchema = z.object({ requestId: z.string(), result: z.unknown() });

export type SocketLine = z.infer<typeof socketLineSchema>;
export type ToolCall = z.infer<typeof toolCallSchema>;
export type ToolAnswer = z.infer<typeof toolAnswerSchema>;

export function searchBlueprints<T extends Pick<LoadedFlow, "name" | "flow">>(
  entries: readonly T[],
  query: string,
): T[] {
  const needle = query.toLowerCase();
  const matches = (text: string) => text.toLowerCase().includes(needle);
  return entries.filter(
    (entry) => matches(entry.name) || entry.flow.nodes.some((node) => matches(node.label)),
  );
}
