import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
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

  it("refuses to list the branches of a folder that is not a repository, naming it", async () => {
    await expect(state.branches(plain)).rejects.toThrow(`${plain} is not a git repository`);
  });
});
