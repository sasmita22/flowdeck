import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { agentCallOf, nodeMarker } from "../../../src/core/run/agent-calls.js";

const fixture = (name: string) =>
  JSON.parse(
    readFileSync(new URL(`../../fixtures/hooks/${name}.json`, import.meta.url), "utf8"),
  ) as Record<string, unknown>;

const postToolUse = fixture("post-tool-use-agent");

const withPrompt = (prompt: string) => ({
  ...postToolUse,
  tool_input: { ...(postToolUse["tool_input"] as object), prompt },
});

const preToolUse = () => {
  const payload: Record<string, unknown> = { ...postToolUse, hook_event_name: "PreToolUse" };
  delete payload["tool_response"];
  delete payload["duration_ms"];
  return payload;
};

describe("nodeMarker", () => {
  it("is NODE followed by the node id", () => {
    expect(nodeMarker("n1")).toBe("NODE n1");
  });
});

describe("agentCallOf", () => {
  it("reads a finished call from PostToolUse(Agent)", () => {
    expect(agentCallOf({ kind: "PostToolUse", payload: postToolUse })).toEqual({
      toolUseId: "toolu_01A8CCuRgXEwumBwrGYfVc1e",
      nodeId: "n1",
      agentType: "fix-login:review",
      agentId: "aa309e9c40045c6c8",
      status: "completed",
    });
  });

  it("reads a piece marker in place of a node marker", () => {
    const call = agentCallOf({
      kind: "PostToolUse",
      payload: withPrompt("PIECE plugin/agents/x.md\nAudit it"),
    });

    expect(call).toMatchObject({ piece: "plugin/agents/x.md" });
    expect(call).not.toHaveProperty("nodeId");
  });

  it("gives neither node nor piece for a prompt with no marker", () => {
    const call = agentCallOf({ kind: "PostToolUse", payload: withPrompt("Go") });

    expect(call).toMatchObject({ toolUseId: "toolu_01A8CCuRgXEwumBwrGYfVc1e" });
    expect(call).not.toHaveProperty("nodeId");
    expect(call).not.toHaveProperty("piece");
  });

  it("reads a launched call from PreToolUse(Agent), with no status", () => {
    expect(agentCallOf({ kind: "PreToolUse", payload: preToolUse() })).toEqual({
      toolUseId: "toolu_01A8CCuRgXEwumBwrGYfVc1e",
      nodeId: "n1",
      agentType: "fix-login:review",
    });
  });

  it.each(["PreToolUse", "PostToolUse"] as const)(
    "ignores %s for a tool other than Agent",
    (kind) => {
      expect(agentCallOf({ kind, payload: { ...postToolUse, tool_name: "Bash" } })).toBeUndefined();
    },
  );

  it.each(["Stop", "StopFailure"] as const)("ignores %s even with an Agent payload", (kind) => {
    expect(agentCallOf({ kind, payload: postToolUse })).toBeUndefined();
  });

  it("flags a SubagentStop with no agent type as a background agent", () => {
    expect(
      agentCallOf({
        kind: "SubagentStop",
        payload: { hook_event_name: "SubagentStop", agent_id: "a2acfd3c49ca63d33", agent_type: "" },
      }),
    ).toEqual({ background: true, agentId: "a2acfd3c49ca63d33" });
  });
});
