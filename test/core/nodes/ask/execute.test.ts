import { describe, expect, it } from "vitest";
import { agentTurnText } from "../../../../src/core/nodes/agent/execute.js";
import {
  askOutcome,
  askRequest,
  withAgentContext,
  withPromptContext,
} from "../../../../src/core/nodes/ask/execute.js";
import type { WaitReply } from "../../../../src/core/run/wait.js";

describe("askRequest", () => {
  it("asks the question with its options", () => {
    expect(
      askRequest("q1", { question: "Pick a colour", options: ["red", "blue", "green"] }),
    ).toEqual({
      nodeId: "q1",
      kind: "ask",
      question: "Pick a colour",
      options: ["red", "blue", "green"],
    });
  });

  it("keeps empty options empty", () => {
    expect(askRequest("q1", { question: "Why?", options: [] })).toEqual({
      nodeId: "q1",
      kind: "ask",
      question: "Why?",
      options: [],
    });
  });
});

describe("askOutcome", () => {
  it("an answer is done with the line answered: <answer>", () => {
    expect(askOutcome("q1", { decision: "answer", answer: "blue" })).toEqual({
      status: "done",
      line: "answered: blue",
      decision: { nodeId: "q1", decision: "answered", answer: "blue" },
    });
  });

  it("closed input fails with no decision", () => {
    expect(askOutcome("q1", { decision: "closed" })).toEqual({
      status: "failed",
      reason: "no answer: input closed",
    });
  });

  it.each<WaitReply>([{ decision: "approve" }, { decision: "continue" }])(
    "fails on a reply not meant for an ask: $decision",
    (reply) => {
      expect(askOutcome("q1", reply)).toEqual({
        status: "failed",
        reason: `unexpected reply: ${reply.decision}`,
      });
    },
  );
});

describe("withPromptContext", () => {
  it("leaves the command alone with no answers", () => {
    expect(withPromptContext("/h1:p1", [])).toBe("/h1:p1");
  });

  it("appends one answer as arguments", () => {
    expect(withPromptContext("/h1:p1", ["blue"])).toBe("/h1:p1 The user answered: blue");
  });

  it("joins several answers in order", () => {
    expect(withPromptContext("/h1:p1", ["red", "blue"])).toBe(
      "/h1:p1 The user answered: red. The user answered: blue",
    );
  });
});

describe("withAgentContext", () => {
  it("leaves the turn text alone with no answers", () => {
    expect(withAgentContext(agentTurnText("h1", "a1"), [])).toBe(agentTurnText("h1", "a1"));
  });

  it("puts the answer before the turn text", () => {
    expect(withAgentContext(agentTurnText("h1", "a1"), ["blue"])).toBe(
      `The user answered: blue. ${agentTurnText("h1", "a1")}`,
    );
  });
});
