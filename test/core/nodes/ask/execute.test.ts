import { describe, expect, it } from "vitest";
import { askOutcome, askRequest } from "../../../../src/core/nodes/ask/execute.js";
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
