export type RunWorktree = { repo: string; base: string; branch: string; path: string };

export type WorktreeRemoval = { worktree: "removed" | "kept"; branch: "removed" | "kept" };

export const repoFolder = (repo: string): string =>
  repo.replace(/\/+$/, "").split("/").at(-1) ?? repo;

export const buildWorktree = ({
  id,
  name,
  repo,
  dir,
}: {
  id: string;
  name: string;
  repo: string;
  dir: string;
}): Pick<RunWorktree, "branch" | "path"> => ({
  branch: `flowdeck/${name}-${id.slice(0, 8)}`,
  path: `${dir}/${repoFolder(repo)}`,
});
