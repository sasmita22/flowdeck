import { describe, expect, it } from "vitest";
import { scopeLine, scopeOf, startsWithScopeLine } from "../../../src/core/compiler/scope-line.js";

const parts = { build: "listing-badge", repo: "mobile-app", workspace: "/fd/workspaces/b1" };

describe("scopeLine", () => {
  it("names the build, repo and workspace and says to use this piece there", () => {
    expect(scopeLine(parts)).toBe(
      "Part of build listing-badge (repo mobile-app, workspace /fd/workspaces/b1). For work in this build's workspace, use this, not a similarly named skill from elsewhere.",
    );
  });

  it("changes with each part", () => {
    expect(scopeLine({ ...parts, build: "other" })).not.toBe(scopeLine(parts));
    expect(scopeLine({ ...parts, repo: "web" })).not.toBe(scopeLine(parts));
    expect(scopeLine({ ...parts, workspace: "/fd/workspaces/b2" })).not.toBe(scopeLine(parts));
  });
});

describe("startsWithScopeLine", () => {
  it("is true only when the description opens with this build's line", () => {
    expect(startsWithScopeLine(`${scopeLine(parts)}\nReviews the diff.`, parts)).toBe(true);
    expect(startsWithScopeLine("Reviews the diff.", parts)).toBe(false);
    expect(startsWithScopeLine(`${scopeLine({ ...parts, build: "other" })}\nReviews.`, parts)).toBe(
      false,
    );
    expect(startsWithScopeLine(`Note. ${scopeLine(parts)}`, parts)).toBe(false);
  });
});

describe("scopeOf", () => {
  it("reads the parts back from a description that opens with a scope line", () => {
    expect(scopeOf(`${scopeLine(parts)}\nReviews the diff.`)).toEqual(parts);
  });

  it("is undefined for a description with no scope line", () => {
    expect(scopeOf("Reviews the diff.")).toBeUndefined();
  });
});
