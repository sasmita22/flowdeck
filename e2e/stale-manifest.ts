import { emit } from "../src/core/compiler/emit.js";
import { lower } from "../src/core/compiler/lower.js";
import type { Flow } from "../src/core/flow/schema.js";

export const manifestOf = (input: Flow, hash: string): string => {
  const files = emit(lower(input, { name: "stale", values: {} }), {
    repo: "/nowhere",
    base: "main",
    branch: "flowdeck/stale",
    branchCreated: true,
    workspace: "/nowhere",
  });
  const manifest = files.find((file) => file.path === "manifest.json");
  if (manifest === undefined) throw new Error("emit wrote no manifest.json");
  return JSON.stringify({ ...(JSON.parse(manifest.content) as object), hash });
};
