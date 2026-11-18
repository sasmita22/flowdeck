import { describe, expect, it } from "vitest";
import {
  otherReposText,
  repoStateSchema,
  repoStateText,
  type RepoState,
} from "../../../src/core/run/repo-state.js";

const onDev: RepoState = {
  kind: "read",
  branch: "dev",
  head: "abc1234",
  upstream: { name: "origin/dev", ahead: 0, behind: 1 },
  staged: 0,
  unstaged: 2,
  untracked: 1,
};

const noUpstream: RepoState = {
  kind: "read",
  branch: "feature/x",
  head: "abc1234",
  upstream: null,
  staged: 0,
  unstaged: 0,
  untracked: 0,
};

describe("repoStateSchema", () => {
  it("parses a read state", () => {
    expect(repoStateSchema.parse(onDev)).toEqual(onDev);
  });

  it("parses an unreadable state", () => {
    expect(repoStateSchema.parse({ kind: "unreadable" })).toEqual({ kind: "unreadable" });
  });

  it("rejects a negative count", () => {
    expect(repoStateSchema.safeParse({ ...onDev, unstaged: -1 }).success).toBe(false);
  });

  it("rejects a negative ahead count", () => {
    expect(
      repoStateSchema.safeParse({
        ...onDev,
        upstream: { name: "origin/dev", ahead: -1, behind: 0 },
      }).success,
    ).toBe(false);
  });
});

describe("repoStateText", () => {
  it("states the branch, head, upstream distance and change counts", () => {
    expect(repoStateText(onDev)).toBe(
      "on dev at abc1234, 1 behind and 0 ahead of origin/dev as of the last fetch; 0 staged, 2 unstaged, 1 untracked",
    );
  });

  it("says when the branch has no upstream", () => {
    expect(repoStateText(noUpstream)).toBe(
      "on feature/x at abc1234, no upstream; 0 staged, 0 unstaged, 0 untracked",
    );
  });

  it("says when HEAD is detached", () => {
    expect(repoStateText({ ...noUpstream, branch: null })).toBe(
      "detached at abc1234, no upstream; 0 staged, 0 unstaged, 0 untracked",
    );
  });

  it("says not recorded for an unreadable state", () => {
    expect(repoStateText({ kind: "unreadable" })).toBe("not recorded");
  });

  it("says not recorded when no state was taken", () => {
    expect(repoStateText(null)).toBe("not recorded");
  });

  it("keeps the text within 300 characters for very long branch and upstream names", () => {
    const long = "b".repeat(500);
    const text = repoStateText({
      ...onDev,
      branch: long,
      upstream: { name: `origin/${long}`, ahead: 0, behind: 1 },
    });
    expect(text.length).toBeLessThanOrEqual(300);
    expect(text).toMatch(/^on b+… at abc1234, 1 behind and 0 ahead of origin\/b+… as of/);
  });
});

describe("otherReposText", () => {
  it("is empty when there are no other repos", () => {
    expect(otherReposText([])).toBe("");
  });

  it("lists each repo with its branch, sorted by path", () => {
    expect(
      otherReposText([
        { path: "/work/zeta", branch: "main" },
        { path: "/work/alpha", branch: "dev" },
      ]),
    ).toBe("/work/alpha (dev); /work/zeta (main)");
  });

  it("lists at most ten and counts the rest", () => {
    const repos = Array.from({ length: 13 }, (_, index) => ({
      path: `/work/repo-${String(index).padStart(2, "0")}`,
      branch: "main",
    }));
    const text = otherReposText(repos);
    expect(text.split("; ")).toHaveLength(11);
    expect(text).toContain("/work/repo-09 (main)");
    expect(text).not.toContain("/work/repo-10");
    expect(text.endsWith("; and 3 more")).toBe(true);
  });

  it("stays within 2,000 characters for many long paths and branches", () => {
    const repos = Array.from({ length: 30 }, (_, index) => ({
      path: `/${String(index).padStart(2, "0")}${"p".repeat(500)}`,
      branch: "b".repeat(500),
    }));
    const text = otherReposText(repos);
    expect(text.length).toBeLessThanOrEqual(2_000);
    expect(text.endsWith("; and 20 more")).toBe(true);
  });
});
