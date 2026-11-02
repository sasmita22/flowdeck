import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { promisify } from "node:util";
import type { FolderState, GitState } from "../../ports/git-state.js";

const run = promisify(execFile);

const git = async (folder: string, ...args: string[]): Promise<string> =>
  (
    await run("git", ["-C", folder, ...args], { env: { ...process.env, LC_ALL: "C" } })
  ).stdout.trim();

function stderrOf(error: unknown): string {
  return error instanceof Error && "stderr" in error ? String(error.stderr) : "";
}

async function isFolder(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export class GitFolderState implements GitState {
  async read(folder: string): Promise<FolderState> {
    if (!(await isFolder(folder))) return { kind: "missing" };
    let head: string;
    try {
      head = await git(folder, "rev-parse", "--abbrev-ref", "HEAD");
    } catch (error) {
      if (stderrOf(error).includes("not a git repository")) return { kind: "not-a-repo" };
      return { kind: "branch", name: await git(folder, "symbolic-ref", "--short", "HEAD") };
    }
    if (head !== "HEAD") return { kind: "branch", name: head };
    return { kind: "detached", commit: await git(folder, "rev-parse", "--short", "HEAD") };
  }
}
