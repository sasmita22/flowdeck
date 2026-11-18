import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitFolderState } from "../../../src/adapters/git/git-state.js";
import { createTmpRepo, type TmpRepo } from "../../fixtures/tmp-repo.js";

const run = promisify(execFile);

async function git(repo: string, ...args: string[]): Promise<string> {
  const { stdout } = await run("git", ["-C", repo, ...args]);
  return stdout.trim();
}

const commitIn = (repo: string, message: string): Promise<string> =>
  git(
    repo,
    "-c",
    "user.name=Flowdeck Test",
    "-c",
    "user.email=test@flowdeck.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "--allow-empty",
    "-m",
    message,
  );

describe("GitFolderState", () => {
  const state = new GitFolderState();
  let repo: TmpRepo;
  let plain: string;

  beforeEach(async () => {
    repo = await createTmpRepo({ commit: true });
    plain = await realpath(await mkdtemp(join(tmpdir(), "fd-plain-")));
  });

  afterEach(async () => {
    await repo.cleanup();
    await rm(plain, { recursive: true, force: true });
  });

  it("reads the checked-out branch", async () => {
    await git(repo.path, "checkout", "--quiet", "-b", "fd-demo");

    expect(await state.read(repo.path)).toEqual({ kind: "branch", name: "fd-demo" });
  });

  it("reads a detached HEAD as its short commit", async () => {
    await git(repo.path, "checkout", "--quiet", "--detach");
    const commit = await git(repo.path, "rev-parse", "--short", "HEAD");

    expect(await state.read(repo.path)).toEqual({ kind: "detached", commit });
  });

  it("reads the branch of a repository with no commits yet", async () => {
    const fresh = await createTmpRepo();
    try {
      await git(fresh.path, "symbolic-ref", "HEAD", "refs/heads/fresh");

      expect(await state.read(fresh.path)).toEqual({ kind: "branch", name: "fresh" });
    } finally {
      await fresh.cleanup();
    }
  });

  it("reports a folder outside any repository as not a repo", async () => {
    expect(await state.read(plain)).toEqual({ kind: "not-a-repo" });
  });

  it("reports a folder that does not exist as missing", async () => {
    expect(await state.read(join(plain, "gone"))).toEqual({ kind: "missing" });
  });

  it("reports a path that is a file as missing", async () => {
    const file = join(plain, "notes.txt");
    await writeFile(file, "");

    expect(await state.read(file)).toEqual({ kind: "missing" });
  });

  it("lists a repository's local branches by name", async () => {
    await git(repo.path, "branch", "dev");
    await git(repo.path, "branch", "feature/x");

    expect(await state.branches(repo.path)).toEqual(["dev", "feature/x", "main"]);
  });

  const addRemote = async (): Promise<string> => {
    const remote = await realpath(await mkdtemp(join(tmpdir(), "fd-remote-")));
    await run("git", ["init", "--quiet", "--bare", remote]);
    await git(repo.path, "remote", "add", "origin", remote);
    await git(repo.path, "branch", "dev");
    await git(repo.path, "push", "--quiet", "origin", "main", "dev");
    return remote;
  };

  it("finds the default branch the remote's HEAD names, not the checked-out one", async () => {
    const remote = await addRemote();
    try {
      await git(repo.path, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/dev");

      expect(await state.defaultBranch(repo.path)).toBe("dev");
    } finally {
      await rm(remote, { recursive: true, force: true });
    }
  });

  it("falls back to the checked-out branch when the remote names no HEAD", async () => {
    const remote = await addRemote();
    try {
      await git(repo.path, "checkout", "--quiet", "-b", "feature/x");

      expect(await state.defaultBranch(repo.path)).toBe("feature/x");
    } finally {
      await rm(remote, { recursive: true, force: true });
    }
  });

  it("falls back to the checked-out branch in a repository with no remote", async () => {
    await git(repo.path, "checkout", "--quiet", "-b", "feature/x");

    expect(await state.defaultBranch(repo.path)).toBe("feature/x");
  });

  it("maps each checked-out branch to its folder, leaving out a detached worktree", async () => {
    const worktrees = await realpath(await mkdtemp(join(tmpdir(), "fd-worktrees-")));
    try {
      const featY = join(worktrees, "feat-y");
      await git(repo.path, "worktree", "add", "--quiet", "-b", "feat-y", featY, "main");
      await git(
        repo.path,
        "worktree",
        "add",
        "--quiet",
        "--detach",
        join(worktrees, "loose"),
        "main",
      );

      expect(await state.checkedOutBranches(repo.path)).toEqual({
        main: repo.path,
        "feat-y": featY,
      });
    } finally {
      await rm(worktrees, { recursive: true, force: true });
    }
  });

  it("refuses to list the branches of a folder that is not a repository, naming it", async () => {
    await expect(state.branches(plain)).rejects.toThrow(`${plain} is not a git repository`);
  });
  describe("repoState", () => {
    let scratch: string;

    beforeEach(async () => {
      scratch = await realpath(await mkdtemp(join(tmpdir(), "fd-scratch-")));
    });

    afterEach(async () => {
      await rm(scratch, { recursive: true, force: true });
    });

    const cloneTrackingDev = async (): Promise<{
      origin: string;
      clone: string;
      other: string;
    }> => {
      const origin = join(scratch, "origin.git");
      await run("git", ["init", "--quiet", "--bare", "--initial-branch=dev", origin]);
      const other = join(scratch, "other");
      await run("git", ["clone", "--quiet", origin, other]);
      await git(other, "checkout", "--quiet", "-b", "dev");
      await commitIn(other, "first");
      await git(other, "push", "--quiet", "origin", "dev");
      const clone = join(scratch, "clone");
      await run("git", ["clone", "--quiet", "--branch", "dev", origin, clone]);
      return { origin, clone, other };
    };

    it("reads how far a branch is behind its fetched upstream", async () => {
      const { clone, other } = await cloneTrackingDev();
      await commitIn(other, "second");
      await git(other, "push", "--quiet", "origin", "dev");
      await git(clone, "fetch", "--quiet");
      const head = (await git(clone, "rev-parse", "HEAD")).slice(0, 7);

      expect(await state.repoState(clone)).toEqual({
        kind: "read",
        branch: "dev",
        head,
        upstream: { name: "origin/dev", ahead: 0, behind: 1 },
        staged: 0,
        unstaged: 0,
        untracked: 0,
      });
    });

    it("reads behind as of the last fetch, never fetching", async () => {
      const { clone, other } = await cloneTrackingDev();
      await commitIn(other, "second");
      await git(other, "push", "--quiet", "origin", "dev");
      await git(clone, "fetch", "--quiet");
      await commitIn(other, "third");
      await git(other, "push", "--quiet", "origin", "dev");

      expect(await state.repoState(clone)).toMatchObject({
        upstream: { name: "origin/dev", ahead: 0, behind: 1 },
      });
    });

    it("reads a branch made with checkout -b as having no upstream", async () => {
      await git(repo.path, "checkout", "--quiet", "-b", "feature/x");
      const head = (await git(repo.path, "rev-parse", "HEAD")).slice(0, 7);

      expect(await state.repoState(repo.path)).toEqual({
        kind: "read",
        branch: "feature/x",
        head,
        upstream: null,
        staged: 0,
        unstaged: 0,
        untracked: 0,
      });
    });

    it("reads a detached HEAD as no branch with its commit", async () => {
      await git(repo.path, "checkout", "--quiet", "--detach");
      const head = (await git(repo.path, "rev-parse", "HEAD")).slice(0, 7);

      expect(await state.repoState(repo.path)).toMatchObject({ kind: "read", branch: null, head });
    });

    it("counts staged, unstaged and untracked files", async () => {
      for (const name of ["a.txt", "b.txt", "c.txt"]) await writeFile(join(repo.path, name), "1");
      await git(repo.path, "add", "a.txt", "b.txt", "c.txt");
      await commitIn(repo.path, "files");
      await writeFile(join(repo.path, "a.txt"), "2");
      await git(repo.path, "add", "a.txt");
      await writeFile(join(repo.path, "b.txt"), "2");
      await writeFile(join(repo.path, "c.txt"), "2");
      await writeFile(join(repo.path, "new.txt"), "1");

      expect(await state.repoState(repo.path)).toMatchObject({
        staged: 1,
        unstaged: 2,
        untracked: 1,
      });
    });

    it("reads a folder that does not exist as unreadable", async () => {
      expect(await state.repoState(join(plain, "gone"))).toEqual({ kind: "unreadable" });
    });

    it("reads a folder outside any repository as unreadable", async () => {
      expect(await state.repoState(plain)).toEqual({ kind: "unreadable" });
    });

    it("reads a linked worktree's own branch", async () => {
      const tree = join(scratch, "tree");
      await git(repo.path, "worktree", "add", "--quiet", "-b", "feat-y", tree, "main");

      expect(await state.repoState(tree)).toMatchObject({ kind: "read", branch: "feat-y" });
    });

    it("never rewrites the index or leaves an index lock", async () => {
      const file = join(repo.path, "a.txt");
      await writeFile(file, "1");
      await git(repo.path, "add", "a.txt");
      await commitIn(repo.path, "file");
      const later = new Date(Date.now() + 60_000);
      await utimes(file, later, later);
      const index = join(repo.path, ".git", "index");
      const before = (await stat(index)).mtimeMs;

      await state.repoState(repo.path);

      expect((await stat(index)).mtimeMs).toBe(before);
      await expect(stat(join(repo.path, ".git", "index.lock"))).rejects.toThrow();
    });
  });

  describe("topLevel", () => {
    it("finds the repository of a file in a subfolder", async () => {
      await mkdir(join(repo.path, "src"));
      const file = join(repo.path, "src", "a.ts");
      await writeFile(file, "");

      expect(await state.topLevel(file)).toBe(repo.path);
    });

    it("finds the repository of a folder", async () => {
      await mkdir(join(repo.path, "src"));

      expect(await state.topLevel(join(repo.path, "src"))).toBe(repo.path);
    });

    it("finds the repository of a path that does not exist through its nearest parent", async () => {
      expect(await state.topLevel(join(repo.path, "gone", "deeper", "a.ts"))).toBe(repo.path);
    });

    it("answers null for a path outside any repository", async () => {
      expect(await state.topLevel(join(plain, "a.ts"))).toBeNull();
    });

    it("finds a linked worktree's own top level", async () => {
      const worktrees = await realpath(await mkdtemp(join(tmpdir(), "fd-worktrees-")));
      try {
        const tree = join(worktrees, "feat-y");
        await git(repo.path, "worktree", "add", "--quiet", "-b", "feat-y", tree, "main");
        await mkdir(join(tree, "src"));

        expect(await state.topLevel(join(tree, "src", "a.ts"))).toBe(tree);
      } finally {
        await rm(worktrees, { recursive: true, force: true });
      }
    });
  });
});
