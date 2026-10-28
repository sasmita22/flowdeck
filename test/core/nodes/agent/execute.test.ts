import { describe, expect, it } from "vitest";
import {
  agentOutcome,
  agentTurnText,
  agentType,
} from "../../../../src/core/nodes/agent/execute.js";

describe("agentType", () => {
  it("names the build's agent as <hash>:<node id>", () => {
    expect(agentType("h1", "a1")).toBe("h1:a1");
  });
});

describe("agentTurnText", () => {
  it("asks for the build's agent with a fixed prompt and nothing else", () => {
    expect(agentTurnText("h1", "a1")).toBe(
      'Use the Agent tool with subagent_type "h1:a1" and the prompt "Go". Then reply DONE.',
    );
  });
});

describe("agentOutcome", () => {
  it.each([[[]], [["general-purpose"]], [["h1:a2"]], [["h2:a1"]]])(
    "fails when the agent types seen are %j",
    (seen) => {
      expect(agentOutcome(seen, "h1", "a1")).toBe("failed");
    },
  );

  it.each([[["h1:a1"]], [["general-purpose", "h1:a1"]]])(
    "is done when the agent types seen are %j",
    (seen) => {
      expect(agentOutcome(seen, "h1", "a1")).toBe("done");
    },
  );
});
