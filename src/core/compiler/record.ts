import type { NewBuild } from "../run/store.js";
import { sha256Hex } from "./hash.js";
import type { Manifest } from "./lower.js";

const manifestPath = "manifest.json";

const byPath = (a: { path: string }, b: { path: string }) =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

export type BuildIdentity = Pick<NewBuild, "id" | "name" | "repo" | "base" | "values">;

export function buildRecord(
  dir: string,
  manifestContent: string,
  { id, name, repo, base, values }: BuildIdentity,
): NewBuild {
  const manifest = JSON.parse(manifestContent) as Manifest & { hash: string };
  return {
    id,
    hash: manifest.hash,
    name,
    repo,
    base,
    values,
    dir,
    ...(manifest.source === undefined ? {} : { source: manifest.source }),
    files: [
      ...Object.entries(manifest.files).map(([path, sha256]) => ({ path, sha256 })),
      { path: manifestPath, sha256: sha256Hex(manifestContent) },
    ].sort(byPath),
    nodes: manifest.nodes.map((node) => ({
      nodeId: node.id,
      type: node.type,
      config: node.settings,
      ...(node.file === undefined ? {} : { file: node.file }),
    })),
  };
}
