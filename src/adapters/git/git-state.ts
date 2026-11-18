import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import type { FolderState, GitState, RepoState } from "../../ports/git-state.js";

const run = promisify(execFile);

const git = async (folder: string, ...args: string[]): Promise<string> =>
  (
    await run("git", ["-C", folder, ...args], { env: { ...process.env, LC_ALL: "C" } })
  ).stdout.trim();

const readOnlyGit = async (folder: string, ...args: string[]): Promise<string> =>
  (
    await run("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "-C", folder, ...args], {
      env: { ...process.env, LC_ALL: "C" },
    })
  ).stdout;

function parseStatus(porcelain: string): RepoState {
  let head = "";
  let branch: string | null = null;
  let upstreamName: string | null = null;
  let ahead = 0;
  let behind = 0;
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  for (const line of porcelain.split("\n")) {
    const [kind, first, second, third] = line.split(" ");
    if (kind === "#") {
      if (first === "branch.oid") head = (second ?? "").slice(0, 7);
      else if (first === "branch.head") branch = second === "(detached)" ? null : (second ?? null);
      else if (first === "branch.upstream") upstreamName = second ?? null;
      else if (first === "branch.ab") {
        ahead = Math.abs(Number(second));
        behind = Math.abs(Number(third));
      }
    } else if (kind === "1" || kind === "2") {
      if (first?.[0] !== ".") staged += 1;
      if (first?.[1] !== ".") unstaged += 1;
    } else if (kind === "u") unstaged += 1;
    else if (kind === "?") untracked += 1;
  }
  const upstream = upstreamName === null ? null : { name: upstreamName, ahead, behind };
  return { kind: "read", branch, head, upstream, staged, unstaged, untracked };
}

async function nearestFolder(path: string): Promise<string> {
  let candidate = path;
  for (;;) {
    if (await isFolder(candidate)) return candidate;
    const parent = dirname(candidate);
    if (parent === candidate) return candidate;
    candidate = parent;
  }
}

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

function valueAfter(lines: string[], prefix: string): string | undefined {
  return lines.find((line) => line.startsWith(prefix))?.slice(prefix.length);
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

  async branches(repo: string): Promise<string[]> {
    try {
      await git(repo, "rev-parse", "--git-dir");
    } catch {
      throw new Error(`${repo} is not a git repository`);
    }
    const listed = await git(repo, "for-each-ref", "--format=%(refname:short)", "refs/heads");
    return listed
      .split("\n")
      .filter((name) => name !== "")
      .sort();
  }

  async defaultBranch(repo: string): Promise<string> {
    try {
      const remoteHead = await git(repo, "symbolic-ref", "--short", "refs/remotes/origin/HEAD");
      return remoteHead.replace(/^origin\//, "");
    } catch {
      return git(repo, "symbolic-ref", "--short", "HEAD");
    }
  }

  async checkedOutBranches(repo: string): Promise<Record<string, string>> {
    const records = (await git(repo, "worktree", "list", "--porcelain")).split("\n\n");
    return Object.fromEntries(
      records.flatMap((record) => {
        const lines = record.split("\n");
        const folder = valueAfter(lines, "worktree ");
        const branch = valueAfter(lines, "branch refs/heads/");
        return folder !== undefined && branch !== undefined ? [[branch, folder]] : [];
      }),
    );
  }

  async repoState(folder: string): Promise<RepoState> {
    try {
      return parseStatus(await readOnlyGit(folder, "status", "--porcelain=v2", "--branch"));
    } catch {
      return { kind: "unreadable" };
    }
  }

  async topLevel(path: string): Promise<string | null> {
    try {
      const top = (
        await readOnlyGit(await nearestFolder(path), "rev-parse", "--show-toplevel")
      ).trim();
      return top === "" ? null : top;
    } catch {
      return null;
    }
  }
}
