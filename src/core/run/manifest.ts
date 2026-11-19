import { z } from "zod";
import type { Manifest, ManifestContainer } from "../compiler/lower.js";
import { NodeType, Wire } from "../flow/schema.js";

export type ParsedManifest = Omit<Manifest, "prefix" | "layout" | "nodes" | "wires"> &
  Required<Pick<Manifest, "nodes" | "wires">> & {
    hash: string;
    prefix: string;
    layout: "workspace" | "legacy";
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
  prefix: z.string().optional(),
  session: z.looseObject({ name: z.string() }).optional(),
  containers: z.array(storedContainerSchema),
  nodes: z.array(storedNodeSchema).optional(),
  wires: z.array(Wire).optional(),
});

export function parseManifest(
  text: string,
  build: { hash: string; name: string | null },
): ParsedManifest {
  const parsed: unknown = JSON.parse(text);
  storedManifestSchema.parse(parsed);
  const manifest = parsed as Omit<ParsedManifest, "prefix" | "layout"> & { prefix?: string };
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

const workspaceSession = { name: "workspace" };

export function stageSourcesOf(
  manifest: Omit<ParsedManifest, "hash" | "prefix" | "layout">,
): StageSources {
  const { containers } = manifest;
  const [session, nodes, wires] =
    manifest.session === undefined
      ? [
          workspaceSession,
          containers.flatMap((container) => container.nodes),
          containers.flatMap((container) => container.wires),
        ]
      : [manifest.session, manifest.nodes, manifest.wires];
  return {
    session: { name: session.name },
    nodes: nodes.map((node) => ({
      id: node.id,
      type: node.type,
      label: node.label,
      ...(node.parent === undefined ? {} : { parent: node.parent }),
    })),
    wires: wires.filter((wire) => wire.kind === "then"),
  };
}

export type SessionCheck =
  { ok: true; container: ManifestContainer } | { ok: false; reason: string };

const startOrStop = (node: { type: string }) => node.type === "trigger" || node.type === "output";

export function singleSession(manifest: Pick<ParsedManifest, "containers">): SessionCheck {
  const { containers } = manifest;
  const sessions = containers.filter((container) => container.kind === "session");
  const workspaceIdle = containers
    .filter((container) => container.kind === "workspace")
    .every((workspace) => workspace.nodes.every(startOrStop));
  const [only] = sessions;
  if (sessions.length === 1 && only !== undefined && workspaceIdle) {
    return { ok: true, container: only };
  }
  return { ok: false, reason: "Running several sessions is not supported yet." };
}
