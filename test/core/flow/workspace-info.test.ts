import { describe, expect, it } from "vitest";
import {
  folderStateSchema,
  workspaceLabel,
  type FolderState,
} from "../../../src/core/flow/workspace-info.js";

const folder = { kind: "path", path: "/Users/me/code/shop" } as const;

describe("workspaceLabel for an existing folder", () => {
  it.each<[string, FolderState, string]>([
    ["a branch", { kind: "branch", name: "fd-demo" }, "fd-demo"],
    ["a detached HEAD", { kind: "detached", commit: "abc1234" }, "detached at abc1234"],
    ["a folder that is not a repo", { kind: "not-a-repo" }, "not a git repo"],
    ["a missing folder", { kind: "missing" }, "folder not found"],
  ])("names the folder and gives %s its own text", (_case, state, branch) => {
    expect(workspaceLabel(folder, state)).toEqual({
      folder: { name: "shop", title: "/Users/me/code/shop" },
      branch,
    });
  });

  it("shows no branch until the folder's state is known", () => {
    expect(workspaceLabel(folder)).toEqual({
      folder: { name: "shop", title: "/Users/me/code/shop" },
      branch: "",
    });
  });

  it("names a folder given with a trailing slash by its last segment", () => {
    expect(workspaceLabel({ kind: "path", path: "/Users/me/code/shop/" }).folder).toEqual({
      name: "shop",
      title: "/Users/me/code/shop/",
    });
  });

  it("names the root folder by its path", () => {
    expect(workspaceLabel({ kind: "path", path: "/" }).folder.name).toBe("/");
  });
});

describe("workspaceLabel for a new worktree", () => {
  it("names the repository and the base branch the worktree starts from", () => {
    expect(
      workspaceLabel(
        { kind: "worktree", branch: "dev", repo: "/Users/me/code/shop" },
        { kind: "branch", name: "main" },
      ),
    ).toEqual({
      folder: { name: "shop", title: "/Users/me/code/shop" },
      branch: "new worktree from dev",
    });
  });

  it("says the repository is not set when it has none", () => {
    expect(workspaceLabel({ kind: "worktree", branch: "main" })).toEqual({
      folder: { name: "repository not set", title: "" },
      branch: "new worktree from main",
    });
  });
});

describe("folderStateSchema", () => {
  it.each<FolderState>([
    { kind: "branch", name: "main" },
    { kind: "detached", commit: "abc1234" },
    { kind: "not-a-repo" },
    { kind: "missing" },
  ])("accepts $kind", (state) => {
    expect(folderStateSchema.parse(state)).toEqual(state);
  });

  it("refuses a branch without a name", () => {
    expect(folderStateSchema.safeParse({ kind: "branch" }).success).toBe(false);
  });
});
