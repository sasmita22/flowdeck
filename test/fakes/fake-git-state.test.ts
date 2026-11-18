import { describe, expect, it } from "vitest";
import { FakeGitState } from "./fake-git-state.js";

describe("FakeGitState", () => {
  it("answers each folder with its scripted state and records the reads in order", async () => {
    const git = new FakeGitState({
      "/a": { kind: "branch", name: "fd-demo" },
      "/b": { kind: "not-a-repo" },
    });

    expect(await git.read("/a")).toEqual({ kind: "branch", name: "fd-demo" });
    expect(await git.read("/b")).toEqual({ kind: "not-a-repo" });
    expect(git.reads).toEqual(["/a", "/b"]);
  });

  it("answers a folder it was not given as missing", async () => {
    expect(await new FakeGitState().read("/nowhere")).toEqual({ kind: "missing" });
  });

  it("rejects with the scripted failure and records the read", async () => {
    const git = new FakeGitState({}, { failWith: "git not found" });

    await expect(git.read("/a")).rejects.toThrow("git not found");
    expect(git.reads).toEqual(["/a"]);
  });

  it("answers each repository with its scripted branches, and none for any other", async () => {
    const git = new FakeGitState({}, { branches: { "/repo": ["dev", "main"] } });

    expect(await git.branches("/repo")).toEqual(["dev", "main"]);
    expect(await git.branches("/other")).toEqual([]);
  });

  it("rejects a branch listing with the scripted failure", async () => {
    await expect(
      new FakeGitState({}, { failWith: "git not found" }).branches("/r"),
    ).rejects.toThrow("git not found");
  });

  it("answers each repository with its scripted default branch", async () => {
    const git = new FakeGitState({}, { defaultBranches: { "/repo": "dev", "/other": "main" } });

    expect(await git.defaultBranch("/repo")).toBe("dev");
    expect(await git.defaultBranch("/other")).toBe("main");
  });

  it("answers each repository with its scripted checked-out branches, and none for any other", async () => {
    const git = new FakeGitState(
      {},
      { checkedOut: { "/repo": { main: "/repo", "feat-y": "/worktrees/feat-y" } } },
    );

    expect(await git.checkedOutBranches("/repo")).toEqual({
      main: "/repo",
      "feat-y": "/worktrees/feat-y",
    });
    expect(await git.checkedOutBranches("/other")).toEqual({});
  });

  it("rejects a default-branch lookup with the scripted failure", async () => {
    await expect(
      new FakeGitState({}, { failWith: "git not found" }).defaultBranch("/r"),
    ).rejects.toThrow("git not found");
  });
  it("answers each folder with its configured repo state, recording the asks in order", async () => {
    const git = new FakeGitState();
    const dev = {
      kind: "read" as const,
      branch: "dev",
      head: "abc1234",
      upstream: null,
      staged: 0,
      unstaged: 0,
      untracked: 0,
    };
    git.repoStates.set("/a", dev);

    expect(await git.repoState("/a")).toEqual(dev);
    expect(await git.repoState("/b")).toEqual({ kind: "unreadable" });
    expect(git.repoStateCalls).toEqual(["/a", "/b"]);
    expect(git.reads).toEqual([]);
  });

  it("answers a path's top level by exact path, then by the longest folder holding it", async () => {
    const git = new FakeGitState();
    git.tops.set("/x", "/x");
    git.tops.set("/x/inner", "/x/inner");
    git.tops.set("/x/file.ts", "/elsewhere");

    expect(await git.topLevel("/x/file.ts")).toBe("/elsewhere");
    expect(await git.topLevel("/x/inner/src/a.ts")).toBe("/x/inner");
    expect(await git.topLevel("/x/other/a.ts")).toBe("/x");
    expect(await git.topLevel("/xy/a.ts")).toBeNull();
    expect(git.reads).toEqual([]);
  });

  it("never throws on a repo state or top level even when scripted to fail", async () => {
    const git = new FakeGitState({}, { failWith: "git not found" });

    expect(await git.repoState("/a")).toEqual({ kind: "unreadable" });
    expect(await git.topLevel("/a")).toBeNull();
  });
});
