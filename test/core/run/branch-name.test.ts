import { describe, expect, it } from "vitest";
import {
  isValidBranchName,
  legacyBranchName,
  recommendedBranch,
} from "../../../src/core/run/branch-name.js";

describe("recommendedBranch", () => {
  it("puts the build's name under flowdeck/ when no branch has it", () => {
    expect(recommendedBranch("fix-login", [])).toBe("flowdeck/fix-login");
  });

  it("adds -2 when the plain name is taken", () => {
    expect(recommendedBranch("fix-login", ["main", "flowdeck/fix-login"])).toBe(
      "flowdeck/fix-login-2",
    );
  });

  it("counts on to the first free suffix", () => {
    expect(recommendedBranch("fix-login", ["flowdeck/fix-login", "flowdeck/fix-login-2"])).toBe(
      "flowdeck/fix-login-3",
    );
  });

  it("ignores branches that only share a prefix", () => {
    expect(recommendedBranch("fix-login", ["flowdeck/fix-login-page", "fix-login"])).toBe(
      "flowdeck/fix-login",
    );
  });
});

describe("isValidBranchName", () => {
  it.each(["flowdeck/x", "feat-y", "flowdeck/fix-login-2", "a@b", "release/1.2", "feat/HEAD"])(
    "accepts %j",
    (name) => {
      expect(isValidBranchName(name)).toBe(true);
    },
  );

  it.each([
    "",
    "-x",
    "a..b",
    "a//b",
    "a/",
    "a.",
    ".a",
    "a/.b",
    "a.lock",
    "a.lock/b",
    "a@{b",
    "@",
    "HEAD",
    "a b",
    "a\u0001b",
    "a\u007fb",
    "a~b",
    "a^b",
    "a:b",
    "a?b",
    "a*b",
    "a[b",
    "a\\b",
  ])("refuses %j", (name) => {
    expect(isValidBranchName(name)).toBe(false);
  });
});

describe("legacyBranchName", () => {
  it("names the branch after the build and the first eight characters of its id", () => {
    expect(legacyBranchName("wt", "abcdef1234567890")).toBe("flowdeck/wt-abcdef12");
  });
});
