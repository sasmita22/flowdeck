import { describe, expect, it } from "vitest";
import {
  answerContext,
  gateCheckOutcome,
  gateCheckTurn,
  gateRequest,
  gateSkips,
  noVerdictRequest,
} from "../../../../src/core/nodes/gate/execute.js";
import { verdictRequest } from "../../../../src/core/nodes/loop/execute.js";
import type { WaitReply } from "../../../../src/core/run/wait.js";

const always = { stopWhen: "always", condition: "", instruction: "Check the plan" } as const;
const conditional = {
  stopWhen: "conditional",
  condition: "tests fail",
  instruction: "Check tests",
} as const;

describe("gateSkips", () => {
  it.each([
    [always, true, true],
    [always, false, false],
    [conditional, true, false],
    [conditional, false, false],
  ])("%o, auto %s → %s", (settings, auto, expected) => {
    expect(gateSkips(settings, auto)).toBe(expected);
  });
});

describe("gateRequest", () => {
  it("asks an Always Gate with its instruction alone", () => {
    expect(gateRequest("g1", always)).toEqual({
      nodeId: "g1",
      kind: "gate",
      instruction: "Check the plan",
    });
  });

  it("asks a Conditional Gate with its instruction and its condition", () => {
    expect(gateRequest("g1", conditional)).toEqual({
      nodeId: "g1",
      kind: "gate",
      instruction: "Check tests",
      condition: "tests fail",
    });
  });
});

describe("gateCheckTurn", () => {
  it("asks for the Loop verdict on the condition, and never names a hard stop", () => {
    const turn = gateCheckTurn("tests fail");

    expect(turn.startsWith("Before going on, check")).toBe(true);
    expect(turn).toContain(verdictRequest("tests fail"));
    expect(turn).not.toMatch(/hard stop/i);
  });
});

describe("noVerdictRequest", () => {
  it("asks whether to stop or continue, giving the reason", () => {
    const request = noVerdictRequest("g1", "no json block");

    expect(request).toMatchObject({ nodeId: "g1", kind: "ask", options: ["stop", "continue"] });
    expect(request.kind === "ask" && request.question).toContain("no json block");
    expect(request.kind === "ask" && request.question).not.toMatch(/hard stop/i);
  });
});

describe("gateCheckOutcome", () => {
  it("continue is done with the line continued", () => {
    expect(gateCheckOutcome("g1", { decision: "continue" })).toEqual({
      status: "done",
      line: "continued",
      decision: { nodeId: "g1", decision: "continued" },
    });
  });

  it("continue with text keeps the text in the decision", () => {
    expect(gateCheckOutcome("g1", { decision: "continue", text: "use the v2 API" })).toEqual({
      status: "done",
      line: "continued",
      decision: { nodeId: "g1", decision: "continued", text: "use the v2 API" },
    });
  });

  it("continue with blank text records no text", () => {
    expect(gateCheckOutcome("g1", { decision: "continue", text: "  " })).toEqual({
      status: "done",
      line: "continued",
      decision: { nodeId: "g1", decision: "continued" },
    });
  });

  it("stop with a reason fails with the reason", () => {
    expect(gateCheckOutcome("g1", { decision: "stop", reason: "tests fail" })).toEqual({
      status: "failed",
      reason: "stopped: tests fail",
      decision: { nodeId: "g1", decision: "stopped", reason: "tests fail" },
    });
  });

  it("stop with an empty reason fails with stopped alone", () => {
    expect(gateCheckOutcome("g1", { decision: "stop", reason: "" })).toEqual({
      status: "failed",
      reason: "stopped",
      decision: { nodeId: "g1", decision: "stopped", reason: "" },
    });
  });

  it("closed input fails with no decision", () => {
    expect(gateCheckOutcome("g1", { decision: "closed" })).toEqual({
      status: "failed",
      reason: "no answer: input closed",
    });
  });

  it.each<WaitReply>([{ decision: "approve" }, { decision: "reject", reason: "r" }])(
    "fails on a reply not meant for a gate: $decision",
    (reply) => {
      expect(gateCheckOutcome("g1", reply)).toEqual({
        status: "failed",
        reason: `unexpected reply: ${reply.decision}`,
      });
    },
  );

  it("takes continue or stop as the answer to an unreadable verdict, and refuses any other", () => {
    const answer = (text: string) => gateCheckOutcome("g1", { decision: "answer", answer: text });
    const decision = (text: string) => ({ nodeId: "g1", decision: "answered", answer: text });

    expect(answer("continue")).toEqual({
      status: "done",
      line: "answered: continue",
      decision: decision("continue"),
    });
    expect(answer("stop")).toEqual({
      status: "failed",
      reason: "stopped: no readable verdict",
      decision: decision("stop"),
    });
    expect(answer("x")).toEqual({ status: "failed", reason: "unexpected answer: x" });
  });
});

describe("answerContext", () => {
  it("is empty when the user typed nothing", () => {
    expect(answerContext([])).toBe("");
  });

  it("gives each text in order", () => {
    expect(answerContext(["use v2", "skip docs"])).toBe(
      "The user answered: use v2. The user answered: skip docs.",
    );
  });
});
