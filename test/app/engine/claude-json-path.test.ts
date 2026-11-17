import { describe, expect, it } from "vitest";
import { userClaudeJsonPath } from "../../../src/app/engine/claude-json-path.js";

const home = "/home/u";

describe("userClaudeJsonPath", () => {
  it("uses FLOWDECK_CLAUDE_CONFIG over CLAUDE_CONFIG_DIR", () => {
    expect(
      userClaudeJsonPath({ FLOWDECK_CLAUDE_CONFIG: "/x/c.json", CLAUDE_CONFIG_DIR: "/cfg" }, home),
    ).toBe("/x/c.json");
  });

  it("uses .claude.json inside CLAUDE_CONFIG_DIR when it is the only one set", () => {
    expect(userClaudeJsonPath({ CLAUDE_CONFIG_DIR: "/cfg" }, home)).toBe("/cfg/.claude.json");
  });

  it("treats an empty CLAUDE_CONFIG_DIR as unset", () => {
    expect(userClaudeJsonPath({ CLAUDE_CONFIG_DIR: "" }, home)).toBe("/home/u/.claude.json");
  });

  it("treats an empty FLOWDECK_CLAUDE_CONFIG as unset", () => {
    expect(
      userClaudeJsonPath({ FLOWDECK_CLAUDE_CONFIG: "", CLAUDE_CONFIG_DIR: "/cfg" }, home),
    ).toBe("/cfg/.claude.json");
  });

  it("falls back to .claude.json in the home folder when neither is set", () => {
    expect(userClaudeJsonPath({}, home)).toBe("/home/u/.claude.json");
  });
});
