import { describe, expect, it } from "vitest";
import {
  formatCost,
  formatDuration,
  formatTokens,
  formatWhen,
  folderText,
  shortHash,
} from "../../../src/app/renderer/format.js";

describe("format", () => {
  it("shortens a build hash to its first seven characters", () => {
    expect(shortHash("abcdef1234567")).toBe("abcdef1");
  });

  it("writes a time as month, day and 24-hour clock in the local zone", () => {
    const at = new Date(2026, 10, 2, 9, 5);
    expect(formatWhen(at.toISOString())).toBe("Nov 2, 09:05");
    expect(formatWhen(at.getTime())).toBe("Nov 2, 09:05");
  });

  it("writes a duration in the two largest units", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(65_400)).toBe("1m 5s");
    expect(formatDuration(3_725_000)).toBe("1h 2m");
  });

  it("writes a cost in dollars, or says it is not known", () => {
    expect(formatCost(0.2468)).toBe("$0.25");
    expect(formatCost(0)).toBe("$0.00");
    expect(formatCost(null)).toBe("No cost recorded");
  });

  it("names a working folder by its last part, or a new worktree by its branch", () => {
    expect(folderText({ kind: "path", path: "/code/shop/" })).toBe("shop");
    expect(folderText({ kind: "worktree", branch: "main", repo: "/code/shop" })).toBe(
      "shop · new worktree",
    );
    expect(folderText({ kind: "worktree", branch: "main" })).toBe("New worktree");
    expect(folderText(null)).toBe("No folder yet");
  });
});

describe("formatTokens", () => {
  it("says small counts whole and large ones in thousands or millions", () => {
    expect(formatTokens(0)).toBe("0 tokens");
    expect(formatTokens(950)).toBe("950 tokens");
    expect(formatTokens(12_345)).toBe("12.3k tokens");
    expect(formatTokens(2_500_000)).toBe("2.5M tokens");
  });
});
