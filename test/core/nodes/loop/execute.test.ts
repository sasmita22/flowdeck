import { describe, expect, it } from "vitest";
import { agentTurnText } from "../../../../src/core/nodes/agent/execute.js";
import {
  agentVerdictTurnText,
  capAnswer,
  capRequest,
  malformedAnswer,
  malformedRequest,
  nextStep,
  verdictRequest,
} from "../../../../src/core/nodes/loop/execute.js";
import type { WaitReply } from "../../../../src/core/run/wait.js";

const answer = (text: string): WaitReply => ({ decision: "answer", answer: text });
const answered = (text: string) => ({ nodeId: "l1", decision: "answered", answer: text });

describe("verdictRequest", () => {
  it("asks for a fenced json verdict on the condition", () => {
    expect(verdictRequest("no issues left")).toBe(
      'End your reply with a fenced code block tagged json that holds {"done": true} if this condition holds, else {"done": false}. Condition: no issues left',
    );
  });

  it("puts a condition with line breaks on one line", () => {
    const request = verdictRequest("a\nb\r\nc");

    expect(request.endsWith("Condition: a b c")).toBe(true);
    expect(request).not.toMatch(/[\r\n]/);
  });
});

describe("agentVerdictTurnText", () => {
  it("replaces the agent turn's reply DONE with the verdict request", () => {
    const text = agentVerdictTurnText("h1", "a1", "no issues left");

    expect(text).not.toContain("Then reply DONE.");
    expect(text.endsWith(verdictRequest("no issues left"))).toBe(true);
    expect(text).toBe(
      agentTurnText("h1", "a1").replace("Then reply DONE.", verdictRequest("no issues left")),
    );
  });
});

describe("nextStep", () => {
  it.each([
    [1, 3, false, { kind: "round", round: 2 }],
    [2, 3, false, { kind: "round", round: 3 }],
    [3, 3, false, { kind: "cap" }],
    [1, 1, false, { kind: "cap" }],
    [2, 3, true, { kind: "exit" }],
    [3, 3, true, { kind: "exit" }],
  ] as const)("after round %i of %i with done %s", (round, cap, done, step) => {
    expect(nextStep(round, cap, done)).toEqual(step);
  });
});

describe("malformedRequest", () => {
  it("asks whether the loop is done, naming the round and the reason", () => {
    expect(malformedRequest("l1", 2, "no json block")).toEqual({
      nodeId: "l1",
      kind: "ask",
      question: "round 2 gave no readable verdict (no json block). Is the loop done?",
      options: ["done", "again", "fail"],
    });
  });
});

describe("capRequest", () => {
  it("asks whether to continue after the loop or fail", () => {
    expect(capRequest("l1", 3)).toEqual({
      nodeId: "l1",
      kind: "ask",
      question: "cap reached after 3 rounds. Continue after the loop, or fail?",
      options: ["continue", "fail"],
    });
  });
});

describe("malformedAnswer", () => {
  it.each(["done", "again"] as const)("answer %s is chosen and recorded", (choice) => {
    expect(malformedAnswer("l1", 2, answer(choice))).toEqual({
      choice,
      decision: answered(choice),
    });
  });

  it("answer fail fails with no verdict in the round, recorded", () => {
    expect(malformedAnswer("l1", 2, answer("fail"))).toEqual({
      choice: "fail",
      reason: "no verdict in round 2",
      decision: answered("fail"),
    });
  });
});

describe("capAnswer", () => {
  it("answer continue is chosen and recorded", () => {
    expect(capAnswer("l1", 3, answer("continue"))).toEqual({
      choice: "continue",
      decision: answered("continue"),
    });
  });

  it("answer fail fails with the cap reason, recorded", () => {
    expect(capAnswer("l1", 3, answer("fail"))).toEqual({
      choice: "fail",
      reason: "cap reached after 3 rounds",
      decision: answered("fail"),
    });
  });
});

describe.each([
  ["malformedAnswer", (reply: WaitReply) => malformedAnswer("l1", 2, reply)],
  ["capAnswer", (reply: WaitReply) => capAnswer("l1", 3, reply)],
])("%s", (_name, toAnswer) => {
  it("fails on an answer that is not an option, with no decision", () => {
    expect(toAnswer(answer("x"))).toEqual({ choice: "fail", reason: "unexpected answer: x" });
  });

  it("fails when the input closed, with no decision", () => {
    expect(toAnswer({ decision: "closed" })).toEqual({
      choice: "fail",
      reason: "no answer: input closed",
    });
  });

  it.each([
    { decision: "approve" },
    { decision: "continue" },
    { decision: "reject", reason: "no" },
  ] as WaitReply[])("fails on the reply $decision, with no decision", (reply) => {
    expect(toAnswer(reply)).toEqual({
      choice: "fail",
      reason: `unexpected reply: ${reply.decision}`,
    });
  });
});
