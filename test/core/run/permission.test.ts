import { describe, expect, it } from "vitest";
import { permissionDecision, permissionRequest } from "../../../src/core/run/permission.js";
import type { WaitReply } from "../../../src/core/run/wait.js";
import { permission } from "../../fixtures/waits.js";

const payload = (toolName: string | undefined, toolInput: Record<string, unknown>) => ({
  hook_event_name: "PermissionRequest",
  session_id: "s1",
  transcript_path: "/home/.claude/projects/-repo/s1.jsonl",
  cwd: "/repo",
  permission_mode: "default",
  ...(toolName === undefined ? {} : { tool_name: toolName }),
  tool_input: toolInput,
  permission_suggestions: [],
});

describe("permissionRequest", () => {
  it("asks about a Bash call by its command", () => {
    const bash = payload("Bash", { command: "echo hi", description: "Print hi" });

    expect(permissionRequest("n1", bash)).toEqual(permission);
  });

  it.each([
    ["Edit", { file_path: "/repo/a.ts", old_string: "a", new_string: "b" }],
    ["Write", { file_path: "/repo/a.ts", content: "a" }],
    ["Read", { file_path: "/repo/a.ts" }],
  ])("asks about a %s call by its file path", (tool, input) => {
    expect(permissionRequest("n1", payload(tool, input))).toEqual({
      nodeId: "n1",
      kind: "permission",
      tool,
      input: "/repo/a.ts",
    });
  });

  it("shows any other tool's input as JSON", () => {
    const input = { url: "https://example.com", prompt: "Summarise" };

    expect(permissionRequest("n1", payload("WebFetch", input))).toEqual({
      nodeId: "n1",
      kind: "permission",
      tool: "WebFetch",
      input: JSON.stringify(input),
    });
  });

  it("cuts another tool's JSON input to 200 characters", () => {
    const input = { text: "x".repeat(500) };

    expect(permissionRequest("n1", payload("WebSearch", input)).input).toBe(
      JSON.stringify(input).slice(0, 200),
    );
  });

  it("names the tool unknown when the payload has no tool name", () => {
    expect(permissionRequest("n1", payload(undefined, { command: "ls" }))).toMatchObject({
      nodeId: "n1",
      kind: "permission",
      tool: "unknown",
    });
  });
});

describe("permissionDecision", () => {
  it("allows on approve", () => {
    expect(permissionDecision({ decision: "approve" })).toEqual({ behavior: "allow" });
  });

  it("denies on reject with the reason as the message", () => {
    expect(permissionDecision({ decision: "reject", reason: "r" })).toEqual({
      behavior: "deny",
      message: "r",
    });
  });

  it("denies when Flowdeck closed the wait", () => {
    expect(permissionDecision({ decision: "closed" })).toEqual({
      behavior: "deny",
      message: "Flowdeck closed the request before an answer",
    });
  });

  it.each<WaitReply>([
    { decision: "continue" },
    { decision: "stop", reason: "no" },
    { decision: "answer", answer: "yes" },
    { decision: "raise", budget: 2 },
  ])("denies on a $decision reply", (reply) => {
    expect(permissionDecision(reply)).toMatchObject({ behavior: "deny" });
  });
});
