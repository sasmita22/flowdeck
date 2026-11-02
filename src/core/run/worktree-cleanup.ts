import type { Session } from "../flow/schema.js";
import type { SnapshotStatus } from "./snapshot.js";

export type RunWorktree = { repo: string; base: string; branch: string; path: string };

export type WorktreeRemoval = { worktree: "removed" | "kept"; branch: "removed" | "kept" };

export const removesWorktree = (status: SnapshotStatus): boolean => status === "done";

export const runWorktree = (
  folder: Session["workingFolder"],
  home: string,
  claudeSessionId: string,
): RunWorktree | undefined => {
  if (folder.kind !== "worktree" || !folder.repo) return undefined;
  const id8 = claudeSessionId.slice(0, 8);
  return {
    repo: folder.repo,
    base: folder.branch,
    branch: `flowdeck/${id8}`,
    path: `${home}/worktrees/${id8}`,
  };
};

export const keptNotice = (
  { branch, path }: RunWorktree,
  removal: WorktreeRemoval,
): string | undefined => {
  if (removal.worktree === "kept") {
    return `Kept the worktree ${path} and branch ${branch}: they hold this run's changes.`;
  }
  if (removal.branch === "kept") return `Kept the branch ${branch}: it holds this run's commits.`;
  return undefined;
};
