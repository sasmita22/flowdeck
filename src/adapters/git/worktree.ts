import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { promisify } from "node:util";
import type { WorktreeRemoval } from "../../core/run/workspace.js";
import type { Worktree, WorktreeAddOptions, WorktreeRemoveOptions } from "../../ports/worktree.js";

const run = promisify(execFile);

function stderrOf(error: unknown): string {
  return error instanceof Error && "stderr" in error ? String(error.stderr).trim() : "";
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function succeeds(args: string[]): Promise<boolean> {
  try {
    await run("git", args);
    return true;
  } catch {
    return false;
  }
}

export class GitWorktree implements Worktree {
  async add({ repo, base, branch, path }: WorktreeAddOptions): Promise<void> {
    if (!(await succeeds(["-C", repo, "rev-parse", "--git-dir"]))) {
      throw new Error(`${repo} is not a git repository`);
    }
    if (!(await succeeds(["-C", repo, "rev-parse", "--verify", "--quiet", `${base}^{commit}`]))) {
      throw new Error(`Base branch ${base} not found in ${repo}`);
    }
    try {
      await run("git", ["-C", repo, "worktree", "add", "-b", branch, path, base]);
    } catch (error) {
      throw new Error(stderrOf(error) || `git worktree add failed in ${repo}`, { cause: error });
    }
  }

  async remove({ repo, base, branch, path }: WorktreeRemoveOptions): Promise<WorktreeRemoval> {
    const removeArgs = (await exists(path)) ? [path] : ["--force", path];
    await succeeds(["-C", repo, "worktree", "remove", ...removeArgs]);
    if (await exists(path)) return { worktree: "kept", branch: "kept" };
    const ref = `refs/heads/${branch}`;
    if (!(await succeeds(["-C", repo, "rev-parse", "--verify", "--quiet", ref]))) {
      return { worktree: "removed", branch: "removed" };
    }
    if (!(await succeeds(["-C", repo, "merge-base", "--is-ancestor", ref, base]))) {
      return { worktree: "removed", branch: "kept" };
    }
    try {
      await run("git", ["-C", repo, "branch", "-D", branch]);
    } catch (error) {
      throw new Error(stderrOf(error) || `git branch -D ${branch} failed in ${repo}`, {
        cause: error,
      });
    }
    return { worktree: "removed", branch: "removed" };
  }

  async isDirty(path: string): Promise<boolean> {
    const { stdout } = await run("git", ["-C", path, "status", "--porcelain"]);
    return stdout.trim() !== "";
  }

  async hasUnpushed(repo: string, branch: string, base: string): Promise<boolean> {
    const { stdout } = await run("git", [
      "-C",
      repo,
      "rev-list",
      `refs/heads/${branch}`,
      "--not",
      base,
      "--remotes",
    ]);
    return stdout.trim() !== "";
  }

  async deleteBranch(repo: string, branch: string): Promise<void> {
    try {
      await run("git", ["-C", repo, "branch", "-D", branch]);
    } catch (error) {
      throw new Error(stderrOf(error) || `git branch -D ${branch} failed in ${repo}`, {
        cause: error,
      });
    }
  }
}
