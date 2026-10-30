import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Worktree, WorktreeAddOptions } from "../../ports/worktree.js";

const run = promisify(execFile);

function stderrOf(error: unknown): string {
  return error instanceof Error && "stderr" in error ? String(error.stderr).trim() : "";
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
}
