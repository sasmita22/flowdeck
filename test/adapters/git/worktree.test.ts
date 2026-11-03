import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitWorktree } from "../../../src/adapters/git/worktree.js";
import { createTmpRepo, type TmpRepo } from "../../fixtures/tmp-repo.js";

const run = promisify(execFile);

const committer = ["-c", "user.name=Flowdeck Test", "-c", "user.email=test@flowdeck.invalid"];

async function git(repo: string, ...args: string[]): Promise<string> {
  const { stdout } = await run("git", ["-C", repo, ...args]);
  return stdout;
}

const worktreePaths = async (repo: string): Promise<string[]> =>
  (await git(repo, "worktree", "list", "--porcelain"))
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));

const branches = async (repo: string): Promise<string> =>
  git(repo, "branch", "--list", "--format=%(refname:short)");

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe("GitWorktree", () => {
  let repo: TmpRepo;
  let target: string;
  const worktree = new GitWorktree();

  beforeEach(async () => {
    repo = await createTmpRepo({ commit: true });
    target = await realpath(await mkdtemp(join(tmpdir(), "fd-worktrees-")));
  });

  afterEach(async () => {
    await repo.cleanup();
    await rm(target, { recursive: true, force: true });
  });

  it("adds a worktree on a new branch cut from the base", async () => {
    const path = join(target, "abcd1234");

    await worktree.add({ repo: repo.path, base: "main", branch: "flowdeck/abcd1234", path });

    expect(await worktreePaths(repo.path)).toContain(path);
    expect(await branches(repo.path)).toContain("flowdeck/abcd1234");
    expect((await git(path, "rev-parse", "--abbrev-ref", "HEAD")).trim()).toBe("flowdeck/abcd1234");
  });

  it("rejects a base branch that does not exist, naming it, and adds nothing", async () => {
    const path = join(target, "abcd1234");
    const branchesBefore = await branches(repo.path);

    await expect(
      worktree.add({ repo: repo.path, base: "nope", branch: "flowdeck/abcd1234", path }),
    ).rejects.toThrow("nope");

    expect(await worktreePaths(repo.path)).toEqual([repo.path]);
    expect(await branches(repo.path)).toBe(branchesBefore);
    expect(await exists(path)).toBe(false);
  });

  it("rejects a folder that is not a git repository, naming it", async () => {
    const plain = await realpath(await mkdtemp(join(tmpdir(), "fd-plain-")));
    try {
      await expect(
        worktree.add({
          repo: plain,
          base: "main",
          branch: "flowdeck/abcd1234",
          path: join(target, "abcd1234"),
        }),
      ).rejects.toThrow(plain);
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });

  it("rejects a branch that already exists and leaves the first worktree alone", async () => {
    const first = join(target, "first");
    const second = join(target, "second");
    await worktree.add({ repo: repo.path, base: "main", branch: "flowdeck/abcd1234", path: first });

    await expect(
      worktree.add({ repo: repo.path, base: "main", branch: "flowdeck/abcd1234", path: second }),
    ).rejects.toThrow();

    expect(await worktreePaths(repo.path)).toEqual([repo.path, first]);
    expect((await git(first, "rev-parse", "--abbrev-ref", "HEAD")).trim()).toBe(
      "flowdeck/abcd1234",
    );
  });

  const addRunWorktree = async () => {
    const options = {
      repo: repo.path,
      base: "main",
      branch: "flowdeck/abcd1234",
      path: join(target, "abcd1234"),
    };
    await worktree.add(options);
    return options;
  };

  it("removes a clean worktree with no commits of its own, together with its branch", async () => {
    const options = await addRunWorktree();

    expect(await worktree.remove(options)).toEqual({ worktree: "removed", branch: "removed" });

    expect(await worktreePaths(repo.path)).toEqual([repo.path]);
    expect(await branches(repo.path)).toBe("main\n");
    expect(await exists(options.path)).toBe(false);
  });

  it("keeps a worktree holding an untracked file, and its branch", async () => {
    const options = await addRunWorktree();
    await writeFile(join(options.path, "made.txt"), "the run's work\n");

    expect(await worktree.remove(options)).toEqual({ worktree: "kept", branch: "kept" });

    expect(await worktreePaths(repo.path)).toEqual([repo.path, options.path]);
    expect(await branches(repo.path)).toContain("flowdeck/abcd1234");
    expect(await readFile(join(options.path, "made.txt"), "utf8")).toBe("the run's work\n");
  });

  it("removes a clean worktree but keeps a branch that holds a commit of its own", async () => {
    const options = await addRunWorktree();
    await writeFile(join(options.path, "made.txt"), "committed\n");
    await git(options.path, "add", "made.txt");
    await git(options.path, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "work");
    const tip = (await git(repo.path, "rev-parse", "flowdeck/abcd1234")).trim();

    expect(await worktree.remove(options)).toEqual({ worktree: "removed", branch: "kept" });

    expect(await worktreePaths(repo.path)).toEqual([repo.path]);
    expect((await git(repo.path, "rev-parse", "flowdeck/abcd1234")).trim()).toBe(tip);
  });

  it("clears its own entry when the folder is already gone, leaving the user's other worktrees alone", async () => {
    const options = await addRunWorktree();
    const theirs = join(target, "theirs");
    await git(repo.path, "worktree", "add", "-b", "their-work", theirs, "main");
    await rm(theirs, { recursive: true, force: true });
    await rm(options.path, { recursive: true, force: true });

    expect(await worktree.remove(options)).toEqual({ worktree: "removed", branch: "removed" });
    await worktree.remove(options);

    expect(await worktreePaths(repo.path)).toEqual([repo.path, theirs]);
    expect(await branches(repo.path)).toBe("main\ntheir-work\n");
  });

  const commitIn = async (folder: string, file: string): Promise<void> => {
    await writeFile(join(folder, file), `${file}\n`);
    await git(folder, "add", file);
    await git(folder, ...committer, "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", file);
  };

  const addBuildWorktree = async () => {
    const path = join(target, "1a2b3c4d", "repo");
    const branch = "flowdeck/fix-login-1a2b3c4d";
    await worktree.add({ repo: repo.path, base: "main", branch, path });
    return { path, branch };
  };

  it("reads a fresh worktree as clean", async () => {
    const { path } = await addBuildWorktree();

    expect(await worktree.isDirty(path)).toBe(false);
  });

  it("reads a worktree holding an untracked file as dirty", async () => {
    const { path } = await addBuildWorktree();
    await writeFile(join(path, "made.txt"), "work\n");

    expect(await worktree.isDirty(path)).toBe(true);
  });

  it("reads a worktree with a changed tracked file as dirty", async () => {
    const { path } = await addBuildWorktree();
    await commitIn(path, "made.txt");
    await writeFile(join(path, "made.txt"), "changed\n");

    expect(await worktree.isDirty(path)).toBe(true);
  });

  it("finds nothing unpushed on a branch with no commits of its own, in a repo with no remote", async () => {
    const { branch } = await addBuildWorktree();

    expect(await worktree.hasUnpushed(repo.path, branch, "main")).toBe(false);
  });

  it("finds a commit of the branch's own as unpushed in a repo with no remote", async () => {
    const { path, branch } = await addBuildWorktree();
    await commitIn(path, "made.txt");

    expect(await worktree.hasUnpushed(repo.path, branch, "main")).toBe(true);
  });

  it("finds nothing unpushed once the branch's commits are on the base", async () => {
    const { path, branch } = await addBuildWorktree();
    await commitIn(path, "made.txt");
    await git(repo.path, "merge", "--quiet", "--ff-only", branch);

    expect(await worktree.hasUnpushed(repo.path, branch, "main")).toBe(false);
  });

  describe("with a remote", () => {
    let remote: string;

    beforeEach(async () => {
      remote = await realpath(await mkdtemp(join(tmpdir(), "fd-remote-")));
      await run("git", ["init", "--quiet", "--bare", remote]);
      await git(repo.path, "remote", "add", "origin", remote);
      await git(repo.path, "push", "--quiet", "origin", "main");
    });

    afterEach(async () => {
      await rm(remote, { recursive: true, force: true });
    });

    it("finds nothing unpushed once the branch's commits are on a remote ref", async () => {
      const { path, branch } = await addBuildWorktree();
      await commitIn(path, "made.txt");
      await git(path, "push", "--quiet", "origin", branch);

      expect(await worktree.hasUnpushed(repo.path, branch, "main")).toBe(false);
    });

    it("finds a commit made after the last push as unpushed", async () => {
      const { path, branch } = await addBuildWorktree();
      await commitIn(path, "pushed.txt");
      await git(path, "push", "--quiet", "origin", branch);
      await commitIn(path, "local.txt");

      expect(await worktree.hasUnpushed(repo.path, branch, "main")).toBe(true);
    });
  });

  it("deletes a branch holding commits of its own once its worktree is gone, leaving other branches", async () => {
    const { path, branch } = await addBuildWorktree();
    await commitIn(path, "made.txt");
    await git(repo.path, "branch", "theirs");
    await git(repo.path, "worktree", "remove", path);

    await worktree.deleteBranch(repo.path, branch);

    expect(await branches(repo.path)).toBe("main\ntheirs\n");
  });
});
