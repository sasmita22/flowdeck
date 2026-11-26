import type { Flow } from "../flow/schema.js";
import type { VariableValues } from "../flow/variables.js";
import type { BuildSource, NewBuild } from "../run/store.js";
import { canonicalJson } from "./canonical-json.js";
import { emit, reportPath, type EmitTarget } from "./emit.js";
import { hashBuild } from "./hash.js";
import { lower, type BuildFile, type Manifest } from "./lower.js";
import { validate, type ValidationError } from "./validate.js";
import type { VerifyFileSystem } from "./verify.js";

export type BuildFileSystem = VerifyFileSystem & {
  exists(path: string): Promise<boolean>;
  writeFile(path: string, content: string): Promise<void>;
  remove(path: string): Promise<void>;
  realPath(path: string): Promise<string>;
};

export type BuildResult =
  | { ok: true; hash: string; dir: string; record: NewBuild }
  | { ok: false; errors: ValidationError[] };

type BuildWorkspace = EmitTarget & {
  id: string;
  name: string;
  values: VariableValues;
};

export type BuildDeps = {
  fs: BuildFileSystem;
  home: string;
  workspace: BuildWorkspace;
  source?: BuildSource;
};

export type LayDownDeps = Omit<BuildDeps, "fs"> & { kitVersion?: string };

type LayDownResult = { ok: true; files: BuildFile[] } | { ok: false; errors: ValidationError[] };

export const workspaceDir = (home: string, id: string) => `${home}/workspaces/${id}`;

export async function layDown(flow: Flow, deps: LayDownDeps): Promise<LayDownResult> {
  const errors = validate(flow);
  if (errors.length > 0) return { ok: false, errors };
  const { id, name, values, ...target } = deps.workspace;
  const workspace = workspaceDir(deps.home, id);
  const kit = deps.kitVersion === undefined ? {} : { kitVersion: deps.kitVersion };
  const lowered = lower(flow, { name, values, workspace, ...kit }, deps.source);
  return { ok: true, files: emit(lowered, { ...target, workspace }) };
}

const manifestPath = "manifest.json";

const withHash = (files: readonly BuildFile[], hash: string): BuildFile[] =>
  files.map((file) =>
    file.path === manifestPath
      ? {
          path: manifestPath,
          content: canonicalJson({ ...(JSON.parse(file.content) as Manifest), hash }),
        }
      : file,
  );

const manifestLast = (a: BuildFile, b: BuildFile) =>
  Number(a.path === manifestPath) - Number(b.path === manifestPath);

export async function lockBuild(
  fs: BuildFileSystem,
  dir: string,
  laidDown: readonly BuildFile[],
): Promise<{ hash: string; manifest: string }> {
  const hash = hashBuild(laidDown.filter((file) => file.path !== reportPath));
  const files = withHash(laidDown, hash);
  for (const file of [...files].sort(manifestLast)) {
    await fs.writeFile(`${dir}/${file.path}`, file.content);
  }
  const manifest = files.find((file) => file.path === manifestPath)?.content ?? "";
  return { hash, manifest };
}
