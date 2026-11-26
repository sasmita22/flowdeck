import { z } from "zod";
import { legacyBranchName } from "./branch-name.js";
import type { RunWorktree, WorktreeRemoval } from "./workspace.js";
import type { BuildRecord, BuildWorktree, Store } from "./store.js";

type DeleteBuildDeps = {
  store: Pick<Store, "findBuild" | "listRuns" | "deleteBuild" | "buildWorktrees">;
  worktree: {
    remove(options: RunWorktree & { force?: boolean }): Promise<WorktreeRemoval>;
    isDirty(path: string): Promise<boolean>;
    hasUnpushed(repo: string, branch: string, base: string): Promise<boolean>;
    deleteBranch(repo: string, branch: string): Promise<void>;
    branchTip(repo: string, branch: string): Promise<string | undefined>;
    deleteRemoteBranch(repo: string, branch: string, tip: string): Promise<string[]>;
  };
  fs: {
    exists(path: string): Promise<boolean>;
    removeTree(path: string, options?: { keep?: string[] }): Promise<void>;
    folders(dir: string): Promise<string[]>;
    readFile(path: string): Promise<string>;
    replaceFile(path: string, content: string): Promise<void>;
  };
  home: string;
  pullRequests: { openOn(repo: string, branch: string): Promise<"open" | "none" | "unknown"> };
  claudeConfig: { projectsDir: string; claudeJson: string };
  sessionFolder?: string;
};

const keptAfterDeleteSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("worktree"), path: z.string() }),
  z.object({
    kind: z.literal("branch"),
    branch: z.string(),
    reason: z.enum(["open-pr", "pr-unknown", "remote-moved", "remote-delete-failed"]).optional(),
    remotes: z.array(z.string()).optional(),
  }),
  z.object({ kind: z.literal("folder"), path: z.string() }),
]);

export type KeptAfterDelete = z.infer<typeof keptAfterDeleteSchema>;

export const deleteBuildResultSchema = z.union([
  z.object({ ok: z.literal(true), kept: z.array(keptAfterDeleteSchema).min(1).optional() }),
  z.object({ ok: z.literal(false), message: z.string() }),
]);

export type DeleteBuildResult = z.infer<typeof deleteBuildResultSchema>;

const segments = (path: string): string[] =>
  path.split("/").reduce<string[]>((parts, part) => {
    if (part === "" || part === ".") return parts;
    if (part === "..") return parts.slice(0, -1);
    return [...parts, part];
  }, []);

export const isInside = (folder: string, path: string): boolean => {
  const outer = segments(folder);
  const inner = segments(path);
  return inner.length > outer.length && outer.every((part, index) => inner[index] === part);
};

const deleted = (
  deps: DeleteBuildDeps,
  id: string,
  kept: readonly KeptAfterDelete[] = [],
): DeleteBuildResult => {
  deps.store.deleteBuild(id);
  return kept.length === 0 ? { ok: true } : { ok: true, kept: [...kept] };
};

export type TeardownDeps = Pick<DeleteBuildDeps, "worktree" | "fs">;

const holdsWork = async (deps: TeardownDeps, worktree: RunWorktree): Promise<boolean> =>
  (await deps.worktree.isDirty(worktree.path)) ||
  (worktree.create &&
    (await deps.worktree.hasUnpushed(worktree.repo, worktree.branch, worktree.base)));

async function forceRemove(
  deps: TeardownDeps,
  worktree: RunWorktree,
): Promise<KeptAfterDelete | undefined> {
  const removal = await deps.worktree.remove({ ...worktree, force: true });
  if (removal.worktree === "kept") return { kind: "worktree", path: worktree.path };
  if (worktree.create && removal.branch === "kept") {
    await deps.worktree.deleteBranch(worktree.repo, worktree.branch);
  }
  return undefined;
}

async function removeUnlessHoldingWork(
  deps: TeardownDeps,
  worktree: RunWorktree,
): Promise<KeptAfterDelete | undefined> {
  const present = await deps.fs.exists(worktree.path);
  const keptWorktree: KeptAfterDelete = { kind: "worktree", path: worktree.path };
  if (present && (await holdsWork(deps, worktree))) return keptWorktree;
  const removal = await deps.worktree.remove(worktree);
  if (removal.worktree === "kept") return keptWorktree;
  const branchLeft = worktree.create && removal.branch === "kept";
  if (present && branchLeft) await deps.worktree.deleteBranch(worktree.repo, worktree.branch);
  return !present && branchLeft ? { kind: "branch", branch: worktree.branch } : undefined;
}

async function removeEach(
  deps: TeardownDeps,
  dir: string,
  worktrees: readonly RunWorktree[],
  remove: (worktree: RunWorktree) => Promise<KeptAfterDelete | undefined>,
): Promise<KeptAfterDelete[]> {
  const kept: KeptAfterDelete[] = [];
  for (const worktree of worktrees) {
    const left = await remove(worktree);
    if (left !== undefined) kept.push(left);
  }
  const keep = kept.flatMap((left) => (left.kind === "worktree" ? [left.path] : []));
  await (keep.length === 0 ? deps.fs.removeTree(dir) : deps.fs.removeTree(dir, { keep }));
  return kept;
}

export const teardownWorkspace = (
  deps: TeardownDeps,
  {
    dir,
    worktrees = [],
    force = false,
  }: { dir: string; worktrees?: readonly RunWorktree[]; force?: boolean },
): Promise<KeptAfterDelete[]> =>
  removeEach(deps, dir, worktrees, (worktree) =>
    force ? forceRemove(deps, worktree) : removeUnlessHoldingWork(deps, worktree),
  );

export const storedBranch = (
  build: BuildRecord,
  name: string,
): { branch: string; create: boolean } =>
  build.branch === null || build.branchCreated === null
    ? { branch: legacyBranchName(name, build.id), create: true }
    : { branch: build.branch, create: build.branchCreated };

export const runWorktreeOf = ({
  repo,
  base,
  branch,
  branchCreated,
  path,
}: BuildWorktree): RunWorktree => ({
  repo,
  base,
  branch,
  create: branchCreated,
  path,
});

const storedWorktrees = (store: Pick<Store, "buildWorktrees">, build: BuildRecord): RunWorktree[] =>
  store.buildWorktrees(build.id).map(runWorktreeOf);

const worktreeStateSchema = z.object({
  dirtyWorktree: z.boolean(),
  unpushedBranch: z.boolean(),
});

export const deletePreviewSchema = worktreeStateSchema.extend({
  worktrees: z
    .array(worktreeStateSchema.extend({ path: z.string(), branch: z.string() }))
    .optional(),
});

export type DeletePreview = z.infer<typeof deletePreviewSchema>;

type WorktreeState = z.infer<typeof worktreeStateSchema>;

const worktreeState = async (
  deps: TeardownDeps,
  worktree: RunWorktree,
): Promise<WorktreeState> => ({
  dirtyWorktree:
    (await deps.fs.exists(worktree.path)) && (await deps.worktree.isDirty(worktree.path)),
  unpushedBranch:
    worktree.create &&
    (await deps.worktree.hasUnpushed(worktree.repo, worktree.branch, worktree.base)),
});

export const worktreePreview = async (
  deps: TeardownDeps,
  worktrees: readonly RunWorktree[],
): Promise<DeletePreview> => {
  const states = [];
  for (const worktree of worktrees) {
    states.push({
      path: worktree.path,
      branch: worktree.branch,
      ...(await worktreeState(deps, worktree)),
    });
  }
  return {
    dirtyWorktree: states.some((state) => state.dirtyWorktree),
    unpushedBranch: states.some((state) => state.unpushedBranch),
    worktrees: states,
  };
};

export const deletePreview = (
  deps: TeardownDeps & { store: Pick<Store, "buildWorktrees"> },
  build: BuildRecord,
): Promise<DeletePreview> => worktreePreview(deps, storedWorktrees(deps.store, build));

const runningMessage = "This build has a run left going. Stop or resume it first.";

export const claudeProjectFolder = (path: string): string => path.replace(/[^a-zA-Z0-9]/g, "-");

async function removeClaudeProjects(deps: DeleteBuildDeps, workspace: string): Promise<void> {
  const name = claudeProjectFolder(workspace);
  const { projectsDir } = deps.claudeConfig;
  for (const folder of await deps.fs.folders(projectsDir)) {
    if (folder === name || folder.startsWith(`${name}-`)) {
      await deps.fs.removeTree(`${projectsDir}/${folder}`);
    }
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

async function readJson(deps: DeleteBuildDeps, path: string): Promise<unknown> {
  try {
    return JSON.parse(await deps.fs.readFile(path));
  } catch {
    return undefined;
  }
}

async function forgetClaudeProjects(deps: DeleteBuildDeps, workspace: string): Promise<void> {
  const { claudeJson } = deps.claudeConfig;
  if (!(await deps.fs.exists(claudeJson))) return;
  const config = await readJson(deps, claudeJson);
  if (!isRecord(config) || !isRecord(config.projects)) return;
  const projects = Object.entries(config.projects);
  const kept = projects.filter(([path]) => path !== workspace && !isInside(workspace, path));
  if (kept.length === projects.length) return;
  const updated = { ...config, projects: Object.fromEntries(kept) };
  await deps.fs.replaceFile(claudeJson, `${JSON.stringify(updated, null, 2)}\n`);
}

async function removeLeftovers(deps: DeleteBuildDeps, workspace?: string): Promise<void> {
  if (deps.sessionFolder !== undefined) await deps.fs.removeTree(deps.sessionFolder);
  if (workspace === undefined) return;
  await removeClaudeProjects(deps, workspace);
  await forgetClaudeProjects(deps, workspace);
}

const keptReason = { open: "open-pr", unknown: "pr-unknown" } as const;

async function removeBuildWorktree(
  deps: DeleteBuildDeps,
  worktree: RunWorktree,
): Promise<KeptAfterDelete | undefined> {
  if (!worktree.create) return forceRemove(deps, worktree);
  const state = await deps.pullRequests.openOn(worktree.repo, worktree.branch);
  if (state !== "none") {
    const kept = await forceRemove(deps, { ...worktree, create: false });
    return kept ?? { kind: "branch", branch: worktree.branch, reason: keptReason[state] };
  }
  const tip = await deps.worktree.branchTip(worktree.repo, worktree.branch);
  const kept = await forceRemove(deps, worktree);
  if (kept !== undefined || tip === undefined) return kept;
  return deleteRemoteBranch(deps, worktree, tip);
}

async function deleteRemoteBranch(
  deps: DeleteBuildDeps,
  { repo, branch }: RunWorktree,
  tip: string,
): Promise<KeptAfterDelete | undefined> {
  try {
    const remotes = await deps.worktree.deleteRemoteBranch(repo, branch, tip);
    return remotes.length === 0
      ? undefined
      : { kind: "branch", branch, reason: "remote-moved", remotes };
  } catch {
    return { kind: "branch", branch, reason: "remote-delete-failed" };
  }
}

async function deleteOldBuild(
  deps: DeleteBuildDeps,
  build: BuildRecord,
): Promise<DeleteBuildResult> {
  if (!isInside(deps.home, build.dir)) {
    await removeLeftovers(deps);
    return deleted(deps, build.id, [{ kind: "folder", path: build.dir }]);
  }
  await deps.fs.removeTree(build.dir);
  await removeLeftovers(deps, build.dir);
  return deleted(deps, build.id);
}

export async function deleteBuild(
  deps: DeleteBuildDeps,
  buildId: string,
): Promise<DeleteBuildResult> {
  const build = deps.store.findBuild(buildId);
  if (build === undefined) {
    return { ok: false, message: `There is no build ${buildId} to delete.` };
  }
  if (deps.store.listRuns().some((run) => run.buildId === buildId && run.status === "running")) {
    return { ok: false, message: runningMessage };
  }
  const worktrees = storedWorktrees(deps.store, build);
  if (worktrees.length === 0) return deleteOldBuild(deps, build);
  const kept = await removeEach(deps, build.dir, worktrees, (worktree) =>
    removeBuildWorktree(deps, worktree),
  );
  await removeLeftovers(deps, build.dir);
  return deleted(deps, build.id, kept);
}
