import type { Flow } from "../flow/schema.js";
import type { BuildSource, NewBuild } from "../run/store.js";
import { canonicalJson } from "./canonical-json.js";
import { resolveConnectors, type ConnectorSource } from "./connectors.js";
import { emit } from "./emit.js";
import { hashBuild } from "./hash.js";
import { lower, type BuildFile, type Manifest } from "./lower.js";
import { buildRecord } from "./record.js";
import { validate, type ValidationError } from "./validate.js";
import { verify, type VerifyFileSystem, type VerifyProblem } from "./verify.js";

export type BuildFileSystem = VerifyFileSystem & {
  exists(path: string): Promise<boolean>;
  writeFile(path: string, content: string): Promise<void>;
  remove(path: string): Promise<void>;
};

export type BuildResult =
  | {
      ok: true;
      hash: string;
      dir: string;
      reused: boolean;
      restored: VerifyProblem[];
      record: NewBuild;
    }
  | { ok: false; errors: ValidationError[] };

export type BuildDeps = {
  fs: BuildFileSystem;
  home: string;
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

async function write(fs: BuildFileSystem, dir: string, files: readonly BuildFile[]) {
  for (const file of [...files].sort(manifestLast)) {
    await fs.writeFile(`${dir}/${file.path}`, file.content);
  }
}

async function restore(
  fs: BuildFileSystem,
  dir: string,
  files: readonly BuildFile[],
  problems: readonly VerifyProblem[],
) {
  for (const { path } of problems.filter(({ problem }) => problem === "extra")) {
    await fs.remove(`${dir}/${path}`);
  }
  await write(fs, dir, files);
}

export async function build(flow: Flow, deps: BuildDeps): Promise<BuildResult> {
  const errors = validate(flow);
  if (errors.length > 0) return { ok: false, errors };
  const connectors = await resolveConnectors(flow.session.connectors, deps.connectors);
  if (!connectors.ok) return connectors;
  const emitted = emit(lower(flow, deps.source));
  const hash = hashBuild(emitted);
  const files = withHash(emitted, hash);
  const dir = `${deps.home}/builds/${hash}`;
  const manifest = files.find((file) => file.path === manifestPath)?.content ?? "";
  const done = (reused: boolean, restored: VerifyProblem[]): BuildResult => ({
    ok: true,
    hash,
    dir,
    reused,
    restored,
    record: buildRecord(dir, manifest),
  });
  if (!(await deps.fs.exists(`${dir}/${manifestPath}`))) {
    await write(deps.fs, dir, files);
    return done(false, []);
  }
  const cached = await verify(dir, { fs: deps.fs });
  if (cached.ok) return done(true, []);
  await restore(deps.fs, dir, files, cached.problems);
  const restored = await verify(dir, { fs: deps.fs });
  if (!restored.ok) {
    return {
      ok: false,
      errors: [
        {
          rule: "build-folder",
          message: `Build folder ${dir} could not be restored (${restored.problems
            .map(({ path, problem }) => `${path}: ${problem}`)
            .join(", ")}). Delete the folder and build again.`,
        },
      ],
    };
  }
  return done(true, cached.problems);
}
