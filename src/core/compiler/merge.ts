import type { BuildReport } from "./build-report.js";
import { canonicalJson } from "./canonical-json.js";
import { reportPath } from "./emit.js";
import { sha256Hex } from "./hash.js";
import type { BuildFile, Manifest, ManifestContainer, ManifestNode } from "./lower.js";
import { orchestratorSkill } from "./orchestrator.js";
import { scopeOf } from "./scope-line.js";

export type MergeResult = {
  files: BuildFile[];
  manifest: Manifest;
  mergedPieces: string[];
  rejected: BuildReport["questions"];
};

type Merge = BuildReport["merges"][number];
type Question = BuildReport["questions"][number];

const manifestPath = "manifest.json";

const mergeable = new Set<ManifestNode["type"]>(["agent"]);

export const descriptionOf = (content: string): string => {
  const line = content.split("\n").find((candidate) => candidate.startsWith("description: "));
  const raw = line?.slice("description: ".length) ?? '""';
  return JSON.parse(raw) as string;
};

const rejection = (
  merge: Merge,
  byId: ReadonlyMap<string, ManifestNode>,
  repeated: ReadonlySet<string>,
  containerOf: ReadonlyMap<string, ManifestContainer>,
): Question | undefined => {
  const unknown = merge.nodeIds.find((id) => !byId.has(id));
  if (unknown !== undefined)
    return {
      nodeId: unknown,
      text: `Merge names node ${unknown}, which this build does not have.`,
    };
  const twice = merge.nodeIds.find((id) => repeated.has(id));
  if (twice !== undefined)
    return { nodeId: twice, text: `Node ${twice} is named in more than one merge.` };
  const [first = ""] = merge.nodeIds;
  const types = new Set(merge.nodeIds.map((id) => byId.get(id)?.type));
  const [type] = types;
  if (types.size > 1 || type === undefined || !mergeable.has(type))
    return {
      nodeId: first,
      text: `Nodes ${merge.nodeIds.join(", ")} cannot share a piece: only agents can.`,
    };
  if (new Set(merge.nodeIds.map((id) => containerOf.get(id))).size > 1)
    return {
      nodeId: first,
      text: `Nodes ${merge.nodeIds.join(", ")} cannot share a piece: they are in different containers.`,
    };
  return undefined;
};

const orchestratorOf = (container: ManifestContainer, laidDown: readonly BuildFile[]) => {
  const old = laidDown.find((file) => file.path === container.orchestrator)?.content ?? "";
  const scope = scopeOf(descriptionOf(old));
  if (scope === undefined) throw new Error("the laid-down orchestrator has no scope line");
  return orchestratorSkill(container, scope);
};

export const applyMerges = (
  laidDown: readonly BuildFile[],
  manifest: Manifest,
  merges: BuildReport["merges"],
): MergeResult => {
  const { containers } = manifest;
  const containerOf = new Map(
    containers.flatMap((container) => container.nodes.map((node) => [node.id, container])),
  );
  const nodes = containers.flatMap((container) => container.nodes);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const position = new Map(nodes.map((node, index) => [node.id, index]));
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const id of merges.flatMap((merge) => [...new Set(merge.nodeIds)])) {
    if (seen.has(id)) repeated.add(id);
    seen.add(id);
  }

  const rejected: Question[] = [];
  const sharedBy = new Map<string, { piece: string; file: string }>();
  const mergedPieces: string[] = [];
  for (const merge of merges) {
    const question = rejection(merge, byId, repeated, containerOf);
    if (question !== undefined) {
      rejected.push(question);
      continue;
    }
    const [first, ...absorbed] = [...merge.nodeIds].sort(
      (a, b) => (position.get(a) ?? 0) - (position.get(b) ?? 0),
    );
    const shared = byId.get(first ?? "");
    if (shared?.file === undefined || shared.piece === undefined) continue;
    const { piece, file } = shared;
    for (const id of absorbed) sharedBy.set(id, { piece, file });
    mergedPieces.push(shared.file);
  }
  if (sharedBy.size === 0) return { files: [...laidDown], manifest, mergedPieces, rejected };

  const removed = new Set([...sharedBy.keys()].flatMap((id) => byId.get(id)?.file ?? []));
  const withShared = (node: ManifestNode) => {
    const shared = sharedBy.get(node.id);
    return shared === undefined ? node : { ...node, ...shared };
  };
  const touched = new Set([...sharedBy.keys()].flatMap((id) => containerOf.get(id) ?? []));
  const merged = containers.map((container) =>
    touched.has(container) ? { ...container, nodes: container.nodes.map(withShared) } : container,
  );
  const orchestrators = new Map(
    merged
      .filter((container) => !containers.includes(container))
      .map((container) => [container.orchestrator, orchestratorOf(container, laidDown)]),
  );

  const kept = laidDown
    .filter((file) => !removed.has(file.path) && file.path !== manifestPath)
    .map((file) => orchestrators.get(file.path) ?? file);
  const result: Manifest = {
    ...manifest,
    ...(manifest.nodes === undefined ? {} : { nodes: manifest.nodes.map(withShared) }),
    containers: merged,
    files: Object.fromEntries(
      kept
        .filter((file) => file.path !== reportPath)
        .map((file) => [file.path, sha256Hex(file.content)]),
    ),
  };
  const files = [...kept, { path: manifestPath, content: canonicalJson(result) }];
  return { files, manifest: result, mergedPieces, rejected };
};
