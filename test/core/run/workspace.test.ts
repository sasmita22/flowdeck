import { describe, expect, it } from "vitest";
import { buildWorktree, repoFolder } from "../../../src/core/run/workspace.js";

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

describe("buildWorktree", () => {
  it("puts the branch under flowdeck/ with the build's name and short id, and the worktree in the workspace under the repo's folder", () => {
    expect(
      buildWorktree({
        id: "0f3a9c2e-1111-2222-3333-444455556666",
        name: "fix-login",
        repo: "/work/carousell-web/",
        dir: "/fd/workspaces/0f3a9c2e-1111-2222-3333-444455556666",
      }),
    ).toEqual({
      branch: "flowdeck/fix-login-0f3a9c2e",
      path: "/fd/workspaces/0f3a9c2e-1111-2222-3333-444455556666/carousell-web",
    });
  });
});
