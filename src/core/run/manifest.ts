import { z } from "zod";
import type { Manifest } from "../compiler/lower.js";
import { NodeType, Wire } from "../flow/schema.js";

export type ParsedManifest = Omit<Manifest, "prefix" | "layout"> & {
  hash: string;
  prefix: string;
  layout: "workspace" | "legacy";
};

const storedManifestSchema = z.looseObject({
  version: z.literal(1),
  hash: z.string(),
  prefix: z.string().optional(),
  session: z.looseObject({ name: z.string() }),
  nodes: z.array(
    z.looseObject({
      id: z.string(),
      type: NodeType,
      label: z.string(),
      parent: z.string().optional(),
    }),
  ),
  wires: z.array(Wire),
});

export function parseManifest(
  text: string,
  build: { hash: string; name: string | null },
): ParsedManifest {
  const parsed: unknown = JSON.parse(text);
  storedManifestSchema.parse(parsed);
  const manifest = parsed as Manifest & { hash: string };
  return {
    ...manifest,
    prefix: manifest.prefix ?? build.hash,
    layout: build.name === null ? "legacy" : "workspace",
  };
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

export function stageSourcesOf(manifest: Omit<Manifest, "prefix" | "layout">): StageSources {
  return {
    session: { name: manifest.session.name },
    nodes: manifest.nodes.map((node) => ({
      id: node.id,
      type: node.type,
      label: node.label,
      ...(node.parent === undefined ? {} : { parent: node.parent }),
    })),
    wires: manifest.wires.filter((wire) => wire.kind === "then"),
  };
}
