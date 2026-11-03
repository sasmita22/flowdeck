import type { Flow } from "../flow/schema.js";
import type { VariableValues } from "../flow/variables.js";
import type { BuildSource, NewBuild } from "../run/store.js";
import { canonicalJson } from "./canonical-json.js";
import { resolveConnectors, type ConnectorSource } from "./connectors.js";
import { emit, type EmitTarget } from "./emit.js";
import { hashBuild } from "./hash.js";
import { lower, type BuildFile, type Manifest } from "./lower.js";
import { buildRecord } from "./record.js";
import { validate, type ValidationError } from "./validate.js";
import type { VerifyFileSystem } from "./verify.js";

export type BuildFileSystem = VerifyFileSystem & {
  exists(path: string): Promise<boolean>;
  writeFile(path: string, content: string): Promise<void>;
  remove(path: string): Promise<void>;
};

export type BuildResult =
  | { ok: true; hash: string; dir: string; record: NewBuild }
  | { ok: false; errors: ValidationError[] };

export type BuildWorkspace = EmitTarget & {
  id: string;
  name: string;
  values: VariableValues;
};

export type BuildDeps = {
  fs: BuildFileSystem;
  home: string;
  workspace: BuildWorkspace;
  source?: BuildSource;
  connectors?: ConnectorSource;
};

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

export async function build(flow: Flow, deps: BuildDeps): Promise<BuildResult> {
  const errors = validate(flow);
  if (errors.length > 0) return { ok: false, errors };
  const connectors = await resolveConnectors(flow.session.connectors, deps.connectors);
  if (!connectors.ok) return connectors;
  const { id, name, values, ...target } = deps.workspace;
  const emitted = emit(lower(flow, { name, values }, deps.source), target);
  const hash = hashBuild(emitted);
  const files = withHash(emitted, hash);
  const dir = `${deps.home}/workspaces/${id}`;
  for (const file of [...files].sort(manifestLast)) {
    await deps.fs.writeFile(`${dir}/${file.path}`, file.content);
  }
  const manifest = files.find((file) => file.path === manifestPath)?.content ?? "";
  return { ok: true, hash, dir, record: buildRecord(dir, manifest, deps.workspace) };
}
