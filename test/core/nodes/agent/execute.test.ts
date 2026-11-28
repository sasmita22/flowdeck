import { describe, expect, it } from "vitest";
import {
  agentOutcome,
  agentPrompt,
  agentTurnNode,
  agentTurnText,
  agentType,
} from "../../../../src/core/nodes/agent/execute.js";
import { agentVerdictTurnText } from "../../../../src/core/nodes/loop/execute.js";
import type { AgentCall } from "../../../../src/core/run/agent-calls.js";

const bare = (id: string) => ({ id });

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

  it("puts the Ask answers inside the prompt, before Go", () => {
    const text = agentTurnText("h1", "review", bare("a1"), ["red", "blue"]);

    expect(promptOf(text)).toBe("NODE a1\nThe user answered: red. The user answered: blue.\nGo");
    expect(text.endsWith('". Then reply DONE.')).toBe(true);
  });

  it("gives two nodes on one piece two prompts that differ in marker", () => {
    const first = agentTurnText("h1", "review", bare("a1"));
    const second = agentTurnText("h1", "review", bare("a2"));

    expect(first).toContain('subagent_type "h1:review"');
    expect(second).toContain('subagent_type "h1:review"');
    expect(promptOf(first)).toBe("NODE a1\nGo");
    expect(promptOf(second)).toBe("NODE a2\nGo");
  });

  it("names the agent <prefix>:<node id> for a build that named no pieces", () => {
    expect(agentTurnText("h1", "a1", bare("a1"))).toContain('subagent_type "h1:a1"');
  });

  it("never mentions given or written files", () => {
    const text = agentTurnText("h1", "review", bare("a1"));

    expect(text).not.toMatch(/You are given|Write:/);
  });
});

describe("agentPrompt for an Agent that produces variables", () => {
  const producer = {
    id: "a1",
    produces: [
      { variable: "approved", yesIf: "tests pass", noIf: "tests fail" },
      { variable: "docs", yesIf: "docs\nchanged", noIf: "no docs changed" },
    ],
  };
  const jsonRequests = (text: string) => text.match(/fenced code block tagged json/g) ?? [];

  it("lists each variable with its Yes if and No if as an acceptance criterion", () => {
    const prompt = agentPrompt(producer);

    expect(prompt.startsWith("NODE a1\n")).toBe(true);
    expect(prompt).toMatch(/acceptance criteri/i);
    expect(prompt).toContain('"approved": true if tests pass, false if tests fail');
    expect(prompt).toContain('"docs": true if docs changed, false if no docs changed');
  });

  it("asks for one final fenced json object holding every variable", () => {
    const prompt = agentPrompt(producer);

    expect(jsonRequests(prompt)).toHaveLength(1);
    expect(prompt).toContain('{"approved": true, "docs": true}');
    expect(prompt.indexOf("Go")).toBeLessThan(prompt.indexOf("fenced code block"));
  });

  it("adds nothing for an Agent with no produce rows", () => {
    expect(agentPrompt({ id: "a1", produces: [] })).toBe("NODE a1\nGo");
  });

  it("puts the produce lines into the subagent's prompt in the main session's turn", () => {
    const text = agentTurnText("h1", "review", producer);

    expect(promptOf(text)).toBe(agentPrompt(producer));
  });

  it("asks the main session to end with the agent's json object, naming every variable, instead of DONE", () => {
    const text = agentTurnText("h1", "review", producer);
    const ending = text.slice(text.lastIndexOf('". ') + 3);

    expect(text).not.toMatch(/Then reply DONE\.$/);
    expect(jsonRequests(ending)).toHaveLength(1);
    expect(ending).toContain('{"approved": true, "docs": true}');
  });

  it("reads the rows from the Agent's settings", () => {
    const node = agentTurnNode({
      id: "a1",
      settings: { role: "", instructions: "", model: "", produces: producer.produces },
    });

    expect(agentPrompt(node)).toBe(agentPrompt(producer));
  });

  it("asks a Loop's last step for one block holding done and every variable", () => {
    const text = agentVerdictTurnText("h1", "review", producer, "no issues left");
    const ending = text.slice(text.lastIndexOf('". ') + 3);

    expect(promptOf(text)).toBe(agentPrompt(producer));
    expect(jsonRequests(ending)).toHaveLength(1);
    expect(ending).toContain('"done": true');
    expect(ending).toContain('"approved": true');
    expect(ending).toContain('"docs": true');
    expect(ending).toContain("no issues left");
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
