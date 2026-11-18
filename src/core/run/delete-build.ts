import { z } from "zod";
import { legacyBranchName } from "./branch-name.js";
import { buildWorktree, type RunWorktree, type WorktreeRemoval } from "./workspace.js";
import type { BuildRecord, Store } from "./store.js";

export type DeleteBuildDeps = {
  store: Pick<Store, "findBuild" | "listRuns" | "deleteBuild">;
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
    removeTree(path: string, options?: { keep?: string }): Promise<void>;
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
  z.object({ ok: z.literal(true), kept: keptAfterDeleteSchema.optional() }),
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

const deleted = (deps: DeleteBuildDeps, id: string, kept?: KeptAfterDelete): DeleteBuildResult => {
  deps.store.deleteBuild(id);
  return kept === undefined ? { ok: true } : { ok: true, kept };
};

export type TeardownDeps = Pick<DeleteBuildDeps, "worktree" | "fs">;

const holdsWork = async (deps: TeardownDeps, worktree: RunWorktree): Promise<boolean> =>
  (await deps.worktree.isDirty(worktree.path)) ||
  (worktree.create &&
    (await deps.worktree.hasUnpushed(worktree.repo, worktree.branch, worktree.base)));

async function forceTeardown(
  deps: TeardownDeps,
  dir: string,
  worktree: RunWorktree,
): Promise<KeptAfterDelete | undefined> {
  const removal = await deps.worktree.remove({ ...worktree, force: true });
  if (removal.worktree === "kept") {
    await deps.fs.removeTree(dir, { keep: worktree.path });
    return { kind: "worktree", path: worktree.path };
  }
  if (worktree.create && removal.branch === "kept") {
    await deps.worktree.deleteBranch(worktree.repo, worktree.branch);
  }
  await deps.fs.removeTree(dir);
  return undefined;
}

export async function teardownWorkspace(
  deps: TeardownDeps,
  { dir, worktree, force = false }: { dir: string; worktree?: RunWorktree; force?: boolean },
): Promise<KeptAfterDelete | undefined> {
  if (worktree === undefined) {
    await deps.fs.removeTree(dir);
    return undefined;
  }
  if (force) return forceTeardown(deps, dir, worktree);
  const present = await deps.fs.exists(worktree.path);
  const keptWorktree: KeptAfterDelete = { kind: "worktree", path: worktree.path };
  if (present && (await holdsWork(deps, worktree))) {
    await deps.fs.removeTree(dir, { keep: worktree.path });
    return keptWorktree;
  }
  const removal = await deps.worktree.remove(worktree);
  if (removal.worktree === "kept") {
    await deps.fs.removeTree(dir, { keep: worktree.path });
    return keptWorktree;
  }
  const branchLeft = worktree.create && removal.branch === "kept";
  if (present && branchLeft) await deps.worktree.deleteBranch(worktree.repo, worktree.branch);
  await deps.fs.removeTree(dir);
  return !present && branchLeft ? { kind: "branch", branch: worktree.branch } : undefined;
}

export const storedBranch = (
  build: BuildRecord,
  name: string,
): { branch: string; create: boolean } =>
  build.branch === null || build.branchCreated === null
    ? { branch: legacyBranchName(name, build.id), create: true }
    : { branch: build.branch, create: build.branchCreated };

const storedWorktree = (build: BuildRecord): RunWorktree | undefined =>
  build.name === null || build.repo === null || build.base === null
    ? undefined
    : {
        repo: build.repo,
        base: build.base,
        ...buildWorktree({ repo: build.repo, dir: build.dir, ...storedBranch(build, build.name) }),
      };

export const deletePreviewSchema = z.object({
  dirtyWorktree: z.boolean(),
  unpushedBranch: z.boolean(),
});

export type DeletePreview = z.infer<typeof deletePreviewSchema>;

export const deletePreview = (deps: TeardownDeps, build: BuildRecord): Promise<DeletePreview> =>
  worktreePreview(deps, storedWorktree(build));

export async function worktreePreview(
  deps: TeardownDeps,
  worktree: RunWorktree | undefined,
): Promise<DeletePreview> {
  if (worktree === undefined) return { dirtyWorktree: false, unpushedBranch: false };
  const dirtyWorktree =
    (await deps.fs.exists(worktree.path)) && (await deps.worktree.isDirty(worktree.path));
  const unpushedBranch =
    worktree.create &&
    (await deps.worktree.hasUnpushed(worktree.repo, worktree.branch, worktree.base));
  return { dirtyWorktree, unpushedBranch };
}

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

async function teardownBuild(
  deps: DeleteBuildDeps,
  dir: string,
  worktree: RunWorktree,
): Promise<KeptAfterDelete | undefined> {
  if (!worktree.create) return forceTeardown(deps, dir, worktree);
  const state = await deps.pullRequests.openOn(worktree.repo, worktree.branch);
  if (state !== "none") {
    const kept = await forceTeardown(deps, dir, { ...worktree, create: false });
    return kept ?? { kind: "branch", branch: worktree.branch, reason: keptReason[state] };
  }
  const tip = await deps.worktree.branchTip(worktree.repo, worktree.branch);
  const kept = await forceTeardown(deps, dir, worktree);
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
    return deleted(deps, build.id, { kind: "folder", path: build.dir });
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
  const worktree = storedWorktree(build);
  if (worktree === undefined) return deleteOldBuild(deps, build);
  const kept = await teardownBuild(deps, build.dir, worktree);
  await removeLeftovers(deps, build.dir);
  return deleted(deps, build.id, kept);
}
