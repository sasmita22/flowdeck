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

export const workspaceFolder = (dir: string): string => `${dir}/workspace`;

export const sessionFolder = (dir: string, slug: string): string => `${dir}/sessions/${slug}`;

export const sessionWorktree = (dir: string, slug: string, repo: string): string =>
  `${sessionFolder(dir, slug)}/${repoFolder(repo)}`;
