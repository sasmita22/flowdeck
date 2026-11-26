import { z } from "zod";
import type { LoadedFlow } from "./flow-store.js";
import { Connection, NodeType, Wire, WireKind } from "./schema.js";

const partialSettings = z.record(z.string(), z.unknown());

const [{ shape: wireShape }] = Wire.options;

export const toolInputs = {
  list_blueprints: z.object({}),
  search_blueprints: z.object({ query: z.string() }),
  read_blueprint: z.object({
    blueprint: z
      .string()
      .optional()
      .describe("The flow id of the blueprint to read. Leave it out for the open blueprint."),
  }),
  add_node: z.strictObject({
    type: NodeType,
    label: z.string(),
    parent: z
      .string()
      .optional()
      .describe(
        "Where the node goes: a Loop or For each id puts it in that body; a workspace or session container id puts it in that container. Leave it out for neither.",
      ),
    settings: partialSettings.default({}),
  }),
  change_node: z.strictObject({
    nodeId: z.string(),
    label: z.string().optional(),
    settings: partialSettings.optional(),
  }),
  wire: z.strictObject({ ...wireShape, kind: WireKind }),
  delete_node: z.strictObject({ nodeId: z.string() }),
  list_builds: z.object({}),
  read_build: z.object({ id: z.string() }),
  tidy_layout: z.strictObject({}),
  add_connection: z.strictObject({ between: Connection.shape.between }),
  delete_connection: z.strictObject({ connectionId: z.string() }),
};

export type ToolName = keyof typeof toolInputs;

const descriptions: Record<ToolName, string> = {
  list_blueprints: "List every saved blueprint. Deleted blueprints are left out.",
  search_blueprints:
    "Find blueprints whose name or any node label contains the query. Deleted blueprints are left out.",
  read_blueprint:
    "Read a blueprint's nodes, wires, containers (the workspace and session containers with their settings), connections and current problems. Reading a deleted blueprint answers that it was deleted.",
  add_node:
    "Add a node to a blueprint, inside a Loop or For each body or a workspace or session container when parent names one. The settings given are merged over the node type's defaults. A library node takes its libraryId in settings; its label is ignored and derived from the library's name, as the canvas derives it.",
  change_node:
    "Change a node's label or some of its settings. A new libraryId re-derives a library node's label and clears the overrides carried over from the old library.",
  wire: "Connect an output port of one node to an input port of another.",
  delete_node: "Delete a node and its wires.",
  list_builds: "List the builds made from blueprints.",
  read_build: "Read one build.",
  tidy_layout:
    "Lay out the open blueprint. It moves nodes only and is part of the ask's one undo step. Call it as the last edit of every ask that added nodes or wires, then check the blueprint.",
  add_connection:
    "Connect two session containers so their sessions may message each other directly. `between` is the two session container ids. Answers the new `connectionId`.",
  delete_connection:
    "Delete one connection by its id, as `read_blueprint` lists it. The sessions stay.",
};

export const toolNames = Object.keys(toolInputs) as ToolName[];

const buildToolNames: ReadonlySet<string> = new Set<ToolName>(["list_builds", "read_build"]);

export const canvasToolNames: ReadonlySet<string> = new Set(
  toolNames.filter((name) => !buildToolNames.has(name)),
);

type ToolDefinition = { name: ToolName; description: string; inputSchema: unknown };

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

export type ToolCall = z.infer<typeof toolCallSchema>;

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
