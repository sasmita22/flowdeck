import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { assertSessionName } from "../../../src/adapters/tmux/tmux-session-host.js";
import {
  BLUEPRINT_SESSION_ALLOWED,
  BLUEPRINT_SESSION_DENIED,
  GITHUB_READ_TOOLS,
  blueprintSessionFolder,
  blueprintSessionName,
  blueprintSessionSettings,
  blueprintSocketPath,
  githubMcpServer,
} from "../../../src/core/compiler/blueprint-session.js";

const home = "/Users/x/.flowdeck";
const hookCommand = "'/Users/x/my node/bin/node' '/Users/x/flow deck/bin/flowdeck-hook.ts'";

const webGuardCommand = "'/Users/x/.flowdeck/hooks/flowdeck-web-guard.cjs'";

const settings = () => blueprintSessionSettings({ home, hookCommand, webGuardCommand });

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
  it("allows skills, reading files, the Flowdeck MCP tools, two GitHub hosts and the GitHub read tools", () => {
    expect(settings().permissions.allow).toStrictEqual([
      "Skill",
      "Read",
      "Glob",
      "Grep",
      "mcp__flowdeck__*",
      "WebFetch(domain:github.com)",
      "WebFetch(domain:raw.githubusercontent.com)",
      "mcp__github__get_commit",
      "mcp__github__get_file_contents",
      "mcp__github__get_latest_release",
      "mcp__github__get_release_by_tag",
      "mcp__github__get_tag",
      "mcp__github__list_branches",
      "mcp__github__list_commits",
      "mcp__github__list_releases",
      "mcp__github__list_repository_collaborators",
      "mcp__github__list_tags",
      "mcp__github__search_code",
      "mcp__github__search_commits",
      "mcp__github__search_repositories",
    ]);
    expect(BLUEPRINT_SESSION_ALLOWED).toStrictEqual(settings().permissions.allow);
  });

  it("denies shell, file edits, web search and the database, but not plain WebFetch", () => {
    expect(settings().permissions.deny).toStrictEqual([
      "Bash",
      "Edit",
      "Write",
      "NotebookEdit",
      "WebSearch",
      "Read(//Users/x/.flowdeck/flowdeck.db*)",
    ]);
    expect(BLUEPRINT_SESSION_DENIED).toStrictEqual([
      "Bash",
      "Edit",
      "Write",
      "NotebookEdit",
      "WebSearch",
    ]);
  });

  it("pins dontAsk so the user's own permission mode never applies", () => {
    expect(settings().permissions.defaultMode).toBe("dontAsk");
  });

  it("runs the web guard before every WebFetch", () => {
    expect(settings().hooks.PreToolUse).toStrictEqual([
      { matcher: "WebFetch", hooks: [{ type: "command", command: webGuardCommand }] },
    ]);
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

describe("GITHUB_READ_TOOLS", () => {
  it("lists the 13 read-only GitHub tools in order", () => {
    expect(GITHUB_READ_TOOLS).toStrictEqual([
      "get_commit",
      "get_file_contents",
      "get_latest_release",
      "get_release_by_tag",
      "get_tag",
      "list_branches",
      "list_commits",
      "list_releases",
      "list_repository_collaborators",
      "list_tags",
      "search_code",
      "search_commits",
      "search_repositories",
    ]);
  });
});

describe("githubMcpServer", () => {
  it("points at GitHub's read-only repos server with the token as a bearer header", () => {
    expect(githubMcpServer("fake-gh-token")).toStrictEqual({
      type: "http",
      url: "https://api.githubcopilot.com/mcp/x/repos/readonly",
      headers: { Authorization: "Bearer fake-gh-token" },
    });
  });
});
