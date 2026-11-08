import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { assertSessionName } from "../../../src/adapters/tmux/tmux-session-host.js";
import {
  blueprintSessionFolder,
  blueprintSessionName,
  blueprintSessionSettings,
  blueprintSocketPath,
} from "../../../src/core/compiler/blueprint-session.js";

const home = "/Users/x/.flowdeck";
const hookCommand = "'/Users/x/my node/bin/node' '/Users/x/flow deck/bin/flowdeck-hook.ts'";

const settings = () => blueprintSessionSettings({ home, hookCommand });

describe("blueprintSessionName", () => {
  it("names the session fd-bp-<flow id>, a name tmux accepts", () => {
    const flowId = randomUUID();
    const name = blueprintSessionName(flowId);

    expect(name).toBe(`fd-bp-${flowId}`);
    expect(name).toMatch(/^fd-[A-Za-z0-9_-]+$/);
    expect(() => assertSessionName(name)).not.toThrow();
  });
});

describe("blueprintSessionFolder", () => {
  it("puts the session folder under bp-sessions in the Flowdeck home", () => {
    expect(blueprintSessionFolder(home, "flow-1")).toBe(`${home}/bp-sessions/flow-1`);
  });
});

describe("blueprintSocketPath", () => {
  it("puts the socket at sockets/bp.sock in the Flowdeck home", () => {
    expect(blueprintSocketPath(home)).toBe(`${home}/sockets/bp.sock`);
  });

  it("stays within the unix socket path limit for a 61-character home", () => {
    const longHome = `/${"a".repeat(60)}`;

    expect(longHome).toHaveLength(61);
    expect(blueprintSocketPath(longHome).length).toBeLessThanOrEqual(104);
  });
});

describe("blueprintSessionSettings", () => {
  it("allows skills, reading files and the Flowdeck MCP tools", () => {
    expect(settings().permissions.allow).toEqual(
      expect.arrayContaining(["Skill", "Read", "Glob", "Grep", "mcp__flowdeck__*"]),
    );
  });

  it("denies shell, file edits and the web", () => {
    expect(settings().permissions.deny).toEqual(
      expect.arrayContaining(["Bash", "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch"]),
    );
  });

  it("denies reading the Flowdeck database by its absolute path", () => {
    expect(settings().permissions.deny).toContain("Read(//Users/x/.flowdeck/flowdeck.db*)");
  });

  it("writes no Glob or Grep path rules, which Claude Code never matches", () => {
    const pathRules = settings().permissions.deny.filter((rule) => /^(Glob|Grep)\(/.test(rule));

    expect(pathRules).toEqual([]);
  });

  it("does not deny Skill", () => {
    expect(settings().permissions.deny).not.toContain("Skill");
  });

  it("forwards Stop to Flowdeck with the given hook command", () => {
    expect(settings().hooks.Stop).toStrictEqual([
      { hooks: [{ type: "command", command: hookCommand }] },
    ]);
  });
});
