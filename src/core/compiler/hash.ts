import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical-json.js";
import type { BuildFile } from "./lower.js";

const withoutHash = (file: BuildFile): string => {
  if (file.path !== "manifest.json") return file.content;
  const manifest = JSON.parse(file.content) as Record<string, unknown>;
  delete manifest.hash;
  return canonicalJson(manifest);
};

export function hashBuild(files: readonly BuildFile[]): string {
  const sha = createHash("sha256");
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const file of sorted) sha.update(`${file.path}\0${withoutHash(file)}\0`);
  return sha.digest("hex");
}
