import { describe, expect, it } from "vitest";
import {
  keptNotice,
  removesWorktree,
  runWorktree,
} from "../../../src/core/run/worktree-cleanup.js";

describe("removesWorktree", () => {
  it("removes the worktree of a run that finished", () => {
    expect(removesWorktree("done")).toBe(true);
  });

  it.each(["failed", "stopped", "interrupted", "running"] as const)(
    "keeps the worktree of a %s run, which can still be inspected, retried or resumed",
    (status) => {
      expect(removesWorktree(status)).toBe(false);
    },
  );
});

describe("runWorktree", () => {
  it("names the run's worktree folder and flowdeck branch from its Claude session id", () => {
    expect(
      runWorktree(
        { kind: "worktree", branch: "main", repo: "/code/shop" },
        "/home/.flowdeck",
        "abcd1234-5678-90ab-cdef-1234567890ab",
      ),
    ).toEqual({
      repo: "/code/shop",
      base: "main",
      branch: "flowdeck/abcd1234",
      path: "/home/.flowdeck/worktrees/abcd1234",
    });
  });

  it.each([
    ["an existing folder", { kind: "path", path: "/code/shop" } as const],
    ["a worktree with no repository", { kind: "worktree", branch: "main" } as const],
  ])("has none for %s", (_case, folder) => {
    expect(runWorktree(folder, "/home/.flowdeck", "abcd1234-0000")).toBeUndefined();
  });
});

describe("keptNotice", () => {
  const worktree = {
    repo: "/code/shop",
    base: "main",
    branch: "flowdeck/abcd1234",
    path: "/home/.flowdeck/worktrees/abcd1234",
  };

  it("says nothing when the worktree and branch were both removed", () => {
    expect(keptNotice(worktree, { worktree: "removed", branch: "removed" })).toBeUndefined();
  });

  it("names the kept worktree and branch, so the user can find the run's changes", () => {
    expect(keptNotice(worktree, { worktree: "kept", branch: "kept" })).toBe(
      "Kept the worktree /home/.flowdeck/worktrees/abcd1234 and branch flowdeck/abcd1234: they hold this run's changes.",
    );
  });

  it("names the kept branch when only the branch holds the run's commits", () => {
    expect(keptNotice(worktree, { worktree: "removed", branch: "kept" })).toBe(
      "Kept the branch flowdeck/abcd1234: it holds this run's commits.",
    );
  });
});
