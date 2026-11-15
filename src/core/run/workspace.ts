export type RunWorktree = {
  repo: string;
  base: string;
  branch: string;
  create: boolean;
  path: string;
};

export type WorktreeRemoval = { worktree: "removed" | "kept"; branch: "removed" | "kept" };

export const repoFolder = (repo: string): string =>
  repo.replace(/\/+$/, "").split("/").at(-1) ?? repo;

export const worktreePath = (dir: string, repo: string): string => `${dir}/${repoFolder(repo)}`;

export const buildWorktree = ({
  repo,
  dir,
  branch,
  create,
}: {
  repo: string;
  dir: string;
  branch: string;
  create: boolean;
}): Pick<RunWorktree, "branch" | "create" | "path"> => ({
  branch,
  create,
  path: worktreePath(dir, repo),
});
