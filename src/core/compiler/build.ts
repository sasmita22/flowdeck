import type { Flow } from "../flow/schema.js";
import { canonicalJson } from "./canonical-json.js";
import { emit } from "./emit.js";
import { hashBuild } from "./hash.js";
import { lower, type Manifest } from "./lower.js";
import { validate, type ValidationError } from "./validate.js";

export type BuildFileSystem = {
  exists(path: string): Promise<boolean>;
  writeFile(path: string, content: string): Promise<void>;
};

export type BuildResult =
  | { ok: true; hash: string; dir: string; reused: boolean }
  | { ok: false; errors: ValidationError[] };

export async function build(
  flow: Flow,
  deps: {
    fs: BuildFileSystem;
    home: string;
    hooks: { nodePath: string; hookScriptPath: string };
  },
): Promise<BuildResult> {
  const errors = validate(flow);
  if (errors.length > 0) return { ok: false, errors };
  const lowered = lower(flow);
  const files = emit(lowered, deps.hooks);
  const hash = hashBuild(files);
  const dir = `${deps.home}/builds/${hash}`;
  if (await deps.fs.exists(`${dir}/manifest.json`)) return { ok: true, hash, dir, reused: true };
  let emittedManifest = "";
  for (const file of files) {
    if (file.path === "manifest.json") emittedManifest = file.content;
    else await deps.fs.writeFile(`${dir}/${file.path}`, file.content);
  }
  const manifest = JSON.parse(emittedManifest) as Manifest;
  await deps.fs.writeFile(`${dir}/manifest.json`, canonicalJson({ ...manifest, hash }));
  return { ok: true, hash, dir, reused: false };
}
