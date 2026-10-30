import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitWorktree } from "../../../src/adapters/git/worktree.js";
import { createTmpRepo, type TmpRepo } from "../../fixtures/tmp-repo.js";

const run = promisify(execFile);

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
});
