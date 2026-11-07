import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { repoFolder } from "../../src/core/run/workspace.js";

const guardPath = fileURLToPath(new URL("../../bin/flowdeck-build-guard.ts", import.meta.url));
const fixture: Record<string, unknown> = JSON.parse(
  readFileSync(new URL("../fixtures/hooks/pre-tool-use.json", import.meta.url), "utf8"),
);

const workspace = mkdtempSync(join(tmpdir(), "fd build guard "));
afterAll(() => rmSync(workspace, { recursive: true, force: true }));

const inWorkspace = (path: string) => join(workspace, path);
const worktree = repoFolder("/repos/demo");

const guard = (tool_name: string, tool_input: Record<string, unknown>, cwd = workspace) =>
  spawnSync(process.execPath, [guardPath, workspace], {
    input: JSON.stringify({ ...fixture, cwd, tool_name, tool_input }),
    encoding: "utf8",
  });

const edit = (file_path: string, old_string = "old") => ({
  file_path,
  old_string,
  new_string: "new",
});

const decisionOf = (stdout: string): unknown =>
  stdout.trim() === ""
    ? undefined
    : (JSON.parse(stdout) as { hookSpecificOutput?: { permissionDecision?: unknown } })
        .hookSpecificOutput?.permissionDecision;

describe("flowdeck-build-guard", () => {
  it.each<[string, string, Record<string, unknown>]>([
    [
      "a Write of a new file",
      "Write",
      { file_path: inWorkspace("plugin/agents/new.md"), content: "x" },
    ],
    ["an Edit that names no file", "Edit", { old_string: "old", new_string: "new" }],
    ["a rename", "Bash", { command: "mv a b" }],
    ["a delete", "Bash", { command: "rm a" }],
    ["any other Bash call", "Bash", { command: "ls" }],
    ["an Edit with an empty old_string", "Edit", edit(inWorkspace("plugin/agents/a.md"), "")],
    ["an Edit inside the worktree", "Edit", edit(inWorkspace(`${worktree}/x`))],
    ["an Edit of the worktree's CLAUDE.md", "Edit", edit(inWorkspace(`${worktree}/CLAUDE.md`))],
    ["an Edit of settings.json", "Edit", edit(inWorkspace("settings.json"))],
    ["an Edit that climbs out of plugin/", "Edit", edit(inWorkspace("plugin/../settings.json"))],
    ["an Edit outside the workspace", "Edit", edit("/tmp/x")],
    ["a relative Edit that climbs out of the workspace", "Edit", edit("plugin/../../escape.md")],
    [
      "NotebookEdit",
      "NotebookEdit",
      { notebook_path: inWorkspace("plugin/a.ipynb"), new_source: "x" },
    ],
    ["WebFetch", "WebFetch", { url: "https://example.com", prompt: "x" }],
    ["WebSearch", "WebSearch", { query: "x" }],
    ["Skill", "Skill", { skill: "x" }],
    ["TodoWrite", "TodoWrite", { todos: [] }],
  ])("denies %s with a reason", (_, tool, input) => {
    const result = guard(tool, input);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout || "{}")).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: expect.stringMatching(/\S/),
      },
    });
  });

  it("denies a tool call it cannot read", () => {
    const result = spawnSync(process.execPath, [guardPath, workspace], {
      input: "not json",
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(decisionOf(result.stdout)).toBe("deny");
  });

  it.each<[string, string, Record<string, unknown>]>([
    ["an Edit under plugin/", "Edit", edit(inWorkspace("plugin/agents/a.md"))],
    ["an Edit of CLAUDE.md", "Edit", edit(inWorkspace("CLAUDE.md"))],
    ["an Edit of build-report.json", "Edit", edit(inWorkspace("build-report.json"))],
    ["an Edit of plugin/hooks/hooks.json", "Edit", edit(inWorkspace("plugin/hooks/hooks.json"))],
    [
      "an Edit of plugin/.claude-plugin/plugin.json",
      "Edit",
      edit(inWorkspace("plugin/.claude-plugin/plugin.json")),
    ],
    ["an Edit given a path relative to the workspace", "Edit", edit("plugin/agents/a.md")],
    ["Read", "Read", { file_path: inWorkspace("plugin/agents/a.md") }],
    ["Glob", "Glob", { pattern: "**/*.md" }],
    ["Grep", "Grep", { pattern: "x" }],
    ["Agent", "Agent", { description: "x", prompt: "x", subagent_type: "general-purpose" }],
  ])("allows %s", (_, tool, input) => {
    const result = guard(tool, input);

    expect(result.status).toBe(0);
    expect(decisionOf(result.stdout)).not.toBe("deny");
  });

  const permissionRequest = (tool_input: Record<string, unknown>) =>
    spawnSync(process.execPath, [guardPath, workspace], {
      input: JSON.stringify({
        ...fixture,
        hook_event_name: "PermissionRequest",
        cwd: workspace,
        tool_name: "Edit",
        tool_input,
      }),
      encoding: "utf8",
    });

  it("approves the permission prompt Claude Code still shows for an allowed Edit under plugin/", () => {
    const result = permissionRequest(edit(inWorkspace("plugin/agents/a.md")));

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout || "{}")).toStrictEqual({
      hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } },
    });
  });

  it("refuses the permission prompt for an Edit the guard would deny", () => {
    const result = permissionRequest(edit(inWorkspace("settings.json")));

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout || "{}")).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "deny", message: expect.stringMatching(/\S/) },
      },
    });
  });

  it("resolves a relative path against the session's cwd", () => {
    const result = guard("Edit", edit("agents/a.md"), inWorkspace("plugin"));

    expect(result.status).toBe(0);
    expect(decisionOf(result.stdout)).not.toBe("deny");
  });
});
