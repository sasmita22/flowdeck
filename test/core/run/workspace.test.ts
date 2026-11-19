import { describe, expect, it } from "vitest";
import {
  repoFolder,
  sessionFolder,
  sessionWorktree,
  workspaceFolder,
} from "../../../src/core/run/workspace.js";

describe("repoFolder", () => {
  it.each([
    ["/work/carousell-web", "carousell-web"],
    ["/work/carousell-web/", "carousell-web"],
    ["/work/carousell-web//", "carousell-web"],
    ["shop", "shop"],
  ])("names %s by its last folder, %s", (repo, folder) => {
    expect(repoFolder(repo)).toBe(folder);
  });
});

describe("container folders", () => {
  const dir = "/fd/builds/fix-login";

  it("puts the workspace folder at the build's workspace", () => {
    expect(workspaceFolder(dir)).toBe("/fd/builds/fix-login/workspace");
  });

  it("puts a session's folder under sessions by its slug", () => {
    expect(sessionFolder(dir, "android")).toBe("/fd/builds/fix-login/sessions/android");
  });

  it("puts a session's worktree in its folder under the repo's folder", () => {
    expect(sessionWorktree(dir, "android", "/work/carousell-android/")).toBe(
      "/fd/builds/fix-login/sessions/android/carousell-android",
    );
  });

  it("gives repos with the same folder name in different sessions different worktrees", () => {
    const first = sessionWorktree(dir, "app", "/work/a/app");
    const second = sessionWorktree(dir, "app-2", "/work/b/app");

    expect(first).toBe("/fd/builds/fix-login/sessions/app/app");
    expect(second).toBe("/fd/builds/fix-login/sessions/app-2/app");
  });
});
