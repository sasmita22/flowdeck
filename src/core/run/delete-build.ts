import { z } from "zod";
import { buildWorktree, type RunWorktree, type WorktreeRemoval } from "./workspace.js";
import type { BuildRecord, Store } from "./store.js";

export type DeleteBuildDeps = {
  store: Pick<Store, "findBuild" | "listRuns" | "deleteBuild">;
  worktree: {
    remove(options: RunWorktree): Promise<WorktreeRemoval>;
    isDirty(path: string): Promise<boolean>;
    hasUnpushed(repo: string, branch: string, base: string): Promise<boolean>;
    deleteBranch(repo: string, branch: string): Promise<void>;
  };
  fs: {
    exists(path: string): Promise<boolean>;
    removeTree(path: string, options?: { keep?: string }): Promise<void>;
  };
  home: string;
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

const isInside = (folder: string, path: string): boolean => {
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
  (await deps.worktree.hasUnpushed(worktree.repo, worktree.branch, worktree.base));

export async function teardownWorkspace(
  deps: TeardownDeps,
  { dir, worktree }: { dir: string; worktree?: RunWorktree },
): Promise<KeptAfterDelete | undefined> {
  if (worktree === undefined) {
    await deps.fs.removeTree(dir);
    return undefined;
  }
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
  if (present && removal.branch === "kept")
    await deps.worktree.deleteBranch(worktree.repo, worktree.branch);
  await deps.fs.removeTree(dir);
  return !present && removal.branch === "kept"
    ? { kind: "branch", branch: worktree.branch }
    : undefined;
}

export async function deleteBuild(
  deps: DeleteBuildDeps,
  buildId: string,
): Promise<DeleteBuildResult> {
  const build = deps.store.findBuild(buildId);
  if (build === undefined || build.deletedAt !== null) {
    return { ok: false, message: `There is no build ${buildId} to delete.` };
  }
  const label = build.name ?? buildId;
  if (deps.store.listRuns().some((run) => run.buildId === buildId && run.status === "running")) {
    return {
      ok: false,
      message: `${label} has a run in progress. Stop it before deleting the build.`,
    };
  }
  if (build.name === null || build.repo === null || build.base === null) {
    return deleteOldBuild(deps, build);
  }
  const worktree: RunWorktree = {
    repo: build.repo,
    base: build.base,
    ...buildWorktree({ id: build.id, name: build.name, repo: build.repo, dir: build.dir }),
  };
  return deleted(deps, build.id, await teardownWorkspace(deps, { dir: build.dir, worktree }));
}
