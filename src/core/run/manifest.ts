import { z } from "zod";
import type { Manifest, ManifestContainer } from "../compiler/lower.js";
import { NodeType, Wire } from "../flow/schema.js";

export type ParsedManifest = Omit<Manifest, "prefix" | "layout" | "nodes" | "wires" | "session"> & {
  hash: string;
};

const storedNodeSchema = z.looseObject({
  id: z.string(),
  type: NodeType,
  label: z.string(),
  parent: z.string().optional(),
});

const storedContainerSchema = z.looseObject({
  kind: z.enum(["workspace", "session"]),
  name: z.string(),
  slug: z.string(),
  prefix: z.string(),
  repo: z.string().optional(),
  base: z.string().optional(),
  branch: z.string().optional(),
  worktree: z.string().optional(),
  model: z.string(),
  nodes: z.array(storedNodeSchema),
  wires: z.array(Wire),
  orchestrator: z.string(),
});

const storedManifestSchema = z.looseObject({
  version: z.literal(1),
  hash: z.string(),
  containers: z.array(storedContainerSchema),
  connections: z.array(z.tuple([z.string(), z.string()])).optional(),
});

export function parseManifest(text: string): ParsedManifest {
  const parsed: unknown = JSON.parse(text);
  storedManifestSchema.parse(parsed);
  return parsed as ParsedManifest;
}

const stageNodeSchema = z.object({
  id: z.string(),
  type: NodeType,
  label: z.string(),
  parent: z.string().optional(),
});

export const stageSourcesSchema = z.object({
  session: z.object({ name: z.string() }),
  nodes: z.array(stageNodeSchema),
  wires: z.array(Wire),
});

export type StageSources = z.infer<typeof stageSourcesSchema>;
export type StageNode = StageSources["nodes"][number];

export type StageGroup = { name: string; nodes: StageNode[]; wires: StageSources["wires"] };

const stageGroupOf = (container: ManifestContainer): StageGroup => ({
  name: container.name,
  nodes: container.nodes.map((node) => ({
    id: node.id,
    type: node.type,
    label: node.label,
    ...(node.parent === undefined ? {} : { parent: node.parent }),
  })),
  wires: container.wires.filter((wire) => wire.kind === "then"),
});

export function workspaceOf(manifest: Pick<ParsedManifest, "containers">): ManifestContainer {
  const workspace = manifest.containers.find((container) => container.kind === "workspace");
  if (workspace === undefined) throw new Error("The build has no workspace container");
  return workspace;
}

export const sessionContainersOf = (
  manifest: Pick<ParsedManifest, "containers">,
): ManifestContainer[] => manifest.containers.filter((container) => container.kind === "session");

export const stageSourcesOf = (manifest: Pick<ParsedManifest, "containers">): StageGroup[] =>
  [
    ...manifest.containers.filter((container) => container.kind === "workspace"),
    ...sessionContainersOf(manifest),
  ].map(stageGroupOf);
