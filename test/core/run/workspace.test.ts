import { describe, expect, it } from "vitest";
import { buildWorktree, repoFolder, worktreePath } from "../../../src/core/run/workspace.js";

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

describe("worktreePath", () => {
  it("puts the worktree in the build's workspace under the repo's folder", () => {
    expect(worktreePath("/fd/workspaces/0f3a9c2e", "/work/carousell-web/")).toBe(
      "/fd/workspaces/0f3a9c2e/carousell-web",
    );
  });
});

describe("buildWorktree", () => {
  it.each([
    ["feat-y", false],
    ["flowdeck/fix-login", true],
  ])("keeps the branch %s it is given, with create %s, at the derived path", (branch, create) => {
    expect(
      buildWorktree({
        repo: "/work/carousell-web/",
        dir: "/fd/workspaces/0f3a9c2e-1111-2222-3333-444455556666",
        branch,
        create,
      }),
    ).toEqual({
      branch,
      create,
      path: "/fd/workspaces/0f3a9c2e-1111-2222-3333-444455556666/carousell-web",
    });
  });
});
