import { describe, expect, it } from "vitest";
import {
  agentOutcome,
  agentTurnText,
  agentType,
} from "../../../../src/core/nodes/agent/execute.js";
import type { AgentCall } from "../../../../src/core/run/agent-calls.js";

const bare = (id: string) => ({ id, given: [], writes: [] });

const promptOf = (text: string) => {
  const match = /the prompt ("(?:[^"\\]|\\.)*")/.exec(text);
  return match?.[1] === undefined ? undefined : (JSON.parse(match[1]) as string);
};

describe("agentType", () => {
  it("names the build's agent as <prefix>:<piece>", () => {
    expect(agentType("h1", "review")).toBe("h1:review");
  });
});

describe("agentTurnText", () => {
  it("asks for the piece's agent, with the node marker first and Go last", () => {
    expect(agentTurnText("h1", "review", bare("a1"))).toBe(
      'Use the Agent tool with subagent_type "h1:review" and the prompt "NODE a1\\nGo". Then reply DONE.',
    );
  });

  it("puts the node's own given and written files between its marker and Go", () => {
    const text = agentTurnText("h1", "review", {
      id: "a1",
      given: ["plan.md"],
      writes: ["notes.md"],
    });

    expect(promptOf(text)).toBe("NODE a1\nYou are given: plan.md\nWrite: notes.md\nGo");
  });

  it("ends with the For each item in place of Go", () => {
    expect(promptOf(agentTurnText("h1", "review", bare("a1"), "alpha"))).toBe(
      "NODE a1\nGo. This round's item: alpha",
    );
  });

  it("puts the Ask answers inside the prompt, before Go", () => {
    const text = agentTurnText(
      "h1",
      "review",
      { id: "a1", given: ["plan.md"], writes: [] },
      undefined,
      ["red", "blue"],
    );

    expect(promptOf(text)).toBe(
      "NODE a1\nYou are given: plan.md\nThe user answered: red. The user answered: blue.\nGo",
    );
    expect(text.endsWith('". Then reply DONE.')).toBe(true);
  });

  it("gives two nodes on one piece two prompts that differ in marker and details", () => {
    const first = agentTurnText("h1", "review", { id: "a1", given: ["a.md"], writes: [] });
    const second = agentTurnText("h1", "review", { id: "a2", given: ["b.md"], writes: [] });

    expect(first).toContain('subagent_type "h1:review"');
    expect(second).toContain('subagent_type "h1:review"');
    expect(promptOf(first)).toBe("NODE a1\nYou are given: a.md\nGo");
    expect(promptOf(second)).toBe("NODE a2\nYou are given: b.md\nGo");
  });

  it("names the agent <prefix>:<node id> for a build that named no pieces", () => {
    expect(agentTurnText("h1", "a1", bare("a1"))).toContain('subagent_type "h1:a1"');
  });
});

describe("agentOutcome", () => {
  const finished = (nodeId: string, toolUseId = `t-${nodeId}`): AgentCall => ({
    toolUseId,
    nodeId,
    agentType: "h1:review",
    status: "completed",
  });
  const launched = (nodeId: string): AgentCall => ({
    toolUseId: `t-${nodeId}`,
    nodeId,
    agentType: "h1:review",
  });

  it("is done when a finished call carries the node's marker", () => {
    expect(agentOutcome([finished("a1")], "a1")).toBe("done");
  });

  it("fails when the only finished call of the same type is another node's", () => {
    expect(agentOutcome([finished("a2")], "a1")).toBe("failed");
  });

  it("fails when the node's call was only launched", () => {
    expect(agentOutcome([launched("a1")], "a1")).toBe("failed");
  });

  it("fails when no call was seen", () => {
    expect(agentOutcome([], "a1")).toBe("failed");
  });
});
