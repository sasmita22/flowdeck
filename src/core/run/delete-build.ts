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
  };
  fs: {
    exists(path: string): Promise<boolean>;
    removeTree(path: string, options?: { keep?: string }): Promise<void>;
  };
  home: string;
  stopRun: (runId: string) => Promise<void>;
};

const keptAfterDeleteSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("worktree"), path: z.string() }),
  z.object({ kind: z.literal("branch"), branch: z.string() }),
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

async function deleteOldBuild(
  deps: DeleteBuildDeps,
  build: BuildRecord,
): Promise<DeleteBuildResult> {
  if (!isInside(deps.home, build.dir)) {
    return deleted(deps, build.id, { kind: "folder", path: build.dir });
  }
  await deps.fs.removeTree(build.dir);
  return deleted(deps, build.id);
}

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

export async function deletePreview(
  deps: TeardownDeps,
  build: BuildRecord,
): Promise<DeletePreview> {
  const worktree = storedWorktree(build);
  if (worktree === undefined) return { dirtyWorktree: false, unpushedBranch: false };
  const dirtyWorktree =
    (await deps.fs.exists(worktree.path)) && (await deps.worktree.isDirty(worktree.path));
  const unpushedBranch =
    worktree.create &&
    (await deps.worktree.hasUnpushed(worktree.repo, worktree.branch, worktree.base));
  return { dirtyWorktree, unpushedBranch };
}

export async function deleteBuild(
  deps: DeleteBuildDeps,
  buildId: string,
): Promise<DeleteBuildResult> {
  const build = deps.store.findBuild(buildId);
  if (build === undefined || build.deletedAt !== null) {
    return { ok: false, message: `There is no build ${buildId} to delete.` };
  }
  const running = deps.store
    .listRuns()
    .filter((run) => run.buildId === buildId && run.status === "running");
  for (const run of running) await deps.stopRun(run.id);
  const worktree = storedWorktree(build);
  if (worktree === undefined) return deleteOldBuild(deps, build);
  return deleted(
    deps,
    build.id,
    await teardownWorkspace(deps, { dir: build.dir, worktree, force: true }),
  );
}
