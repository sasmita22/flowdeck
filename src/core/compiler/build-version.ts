import type { FlowStore, SavedFlowRef } from "../flow/flow-store.js";
import type { BuildConfig, Flow } from "../flow/schema.js";
import { unsetVariables, type VariableValues } from "../flow/variables.js";
import type { FolderState } from "../flow/workspace-info.js";
import type { BuildSource, Store } from "../run/store.js";
import { buildWorktree, type RunWorktree, type WorktreeRemoval } from "../run/workspace.js";
import { build, type BuildDeps, type BuildResult } from "./build.js";
import { validate, type ValidationError } from "./validate.js";

export type BuildRequest = {
  name: string;
  repo?: string;
  base?: string;
  values: VariableValues;
};

export type BuildFlowDeps = Omit<BuildDeps, "source" | "workspace"> & {
  fs: BuildDeps["fs"] & { removeTree(path: string): Promise<void> };
  store: Pick<Store, "recordBuild" | "findBuildByName">;
  gitState: {
    read(folder: string): Promise<FolderState>;
    defaultBranch(repo: string): Promise<string>;
  };
  worktree: {
    add(options: RunWorktree): Promise<void>;
    remove(options: RunWorktree): Promise<WorktreeRemoval>;
  };
  newId: () => string;
};

export type BuildVersionDeps = BuildFlowDeps & { flows: Pick<FlowStore, "load"> };

const kebabCase = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const refused = (rule: string, message: string): BuildResult => ({
  ok: false,
  errors: [{ rule, message }],
});

const withDefaults = (buildConfig: BuildConfig, values: VariableValues): VariableValues => ({
  ...Object.fromEntries(
    buildConfig.variables.flatMap((variable) =>
      variable.default === undefined ? [] : [[variable.name, variable.default]],
    ),
  ),
  ...values,
});

async function requestProblems(
  request: BuildRequest,
  repo: string,
  buildConfig: BuildConfig,
  deps: BuildFlowDeps,
): Promise<ValidationError[]> {
  if (!kebabCase.test(request.name)) {
    return [
      {
        rule: "build-name",
        message: `"${request.name}" is not a build name: use lowercase letters, digits and single hyphens, like fix-login.`,
      },
    ];
  }
  if (deps.store.findBuildByName(request.name) !== undefined) {
    return [{ rule: "build-name", message: `A build named ${request.name} already exists.` }];
  }
  const state = await deps.gitState.read(repo);
  if (state.kind === "missing" || state.kind === "not-a-repo") {
    const problem = state.kind === "missing" ? "does not exist" : "is not a git repository";
    return [{ rule: "build-repo", message: `${repo} ${problem}.` }];
  }
  const unset = unsetVariables(buildConfig, request.values);
  return unset.length === 0
    ? []
    : [{ rule: "build-values", message: `Give a value for ${unset.join(", ")}.` }];
}

export type BuildOrigin = {
  source: BuildSource;
  blueprint: { name: string; version: number };
};

const withRequestTarget = (flow: Flow, { repo, base }: BuildRequest): Flow => ({
  ...flow,
  session: {
    ...flow.session,
    buildConfig: {
      ...flow.session.buildConfig,
      ...(repo === undefined ? {} : { repo }),
      ...(base === undefined ? {} : { base }),
    },
  },
});

export async function buildFlow(
  saved: Flow,
  request: BuildRequest,
  deps: BuildFlowDeps,
  origin?: BuildOrigin,
): Promise<BuildResult> {
  const flow = withRequestTarget(saved, request);
  const { buildConfig } = flow.session;
  const repo = buildConfig.repo ?? "";
  const errors = validate(flow);
  if (errors.length > 0) return { ok: false, errors };
  const problems = await requestProblems(request, repo, buildConfig, deps);
  if (problems.length > 0) return { ok: false, errors: problems };

  const id = deps.newId();
  const base = buildConfig.base ?? (await deps.gitState.defaultBranch(repo));
  const result = await build(flow, {
    ...deps,
    ...(origin === undefined ? {} : { source: origin.source }),
    workspace: {
      id,
      name: request.name,
      values: withDefaults(buildConfig, request.values),
      repo,
      base,
      ...(origin === undefined ? {} : { blueprint: origin.blueprint }),
    },
  });
  if (!result.ok) return result;
  const worktree = {
    repo,
    base,
    ...buildWorktree({ id, name: request.name, repo, dir: result.dir }),
  };
  try {
    await deps.worktree.add(worktree);
  } catch (error) {
    await deps.fs.removeTree(result.dir);
    throw error;
  }
  try {
    deps.store.recordBuild(result.record);
  } catch (error) {
    await deps.worktree.remove(worktree);
    await deps.fs.removeTree(result.dir);
    throw error;
  }
  return result;
}

export async function buildVersion(
  ref: SavedFlowRef,
  request: BuildRequest,
  deps: BuildVersionDeps,
): Promise<BuildResult> {
  const saved = deps.flows.load(ref);
  if (saved === null) {
    return refused("version", `${ref.flowId} has no saved version ${ref.version}`);
  }
  return buildFlow(saved.flow, request, deps, {
    source: { flowId: ref.flowId, version: ref.version },
    blueprint: { name: saved.name, version: saved.version },
  });
}
