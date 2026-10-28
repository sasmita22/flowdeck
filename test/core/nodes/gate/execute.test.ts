import { describe, expect, it } from "vitest";
import { gateOutcome, gateRequest, gateSkips } from "../../../../src/core/nodes/gate/execute.js";
import type { WaitReply } from "../../../../src/core/run/wait.js";

describe("gateSkips", () => {
  it.each([
    [true, true, true],
    [true, false, false],
    [false, true, false],
    [false, false, false],
  ])("skippable %s, auto %s → %s", (skippable, auto, expected) => {
    expect(gateSkips({ shown: "x", skippable }, auto)).toBe(expected);
  });
});

describe("gateRequest", () => {
  it("asks with the gate's shown text", () => {
    expect(gateRequest("g1", { shown: "Check the plan", skippable: false })).toEqual({
      nodeId: "g1",
      kind: "gate",
      shown: "Check the plan",
    });
  });
});

describe("gateOutcome", () => {
  it("approve is done with the line approved", () => {
    expect(gateOutcome("g1", { decision: "approve" })).toEqual({
      status: "done",
      line: "approved",
      decision: { nodeId: "g1", decision: "approved" },
    });
  });

  it("reject with a reason fails with the reason", () => {
    expect(gateOutcome("g1", { decision: "reject", reason: "wrong scope" })).toEqual({
      status: "failed",
      reason: "rejected: wrong scope",
      decision: { nodeId: "g1", decision: "rejected", reason: "wrong scope" },
    });
  });

  it("reject with an empty reason fails with rejected alone", () => {
    expect(gateOutcome("g1", { decision: "reject", reason: "" })).toEqual({
      status: "failed",
      reason: "rejected",
      decision: { nodeId: "g1", decision: "rejected", reason: "" },
    });
  });

  it("closed input fails with no decision", () => {
    expect(gateOutcome("g1", { decision: "closed" })).toEqual({
      status: "failed",
      reason: "no answer: input closed",
    });
  });

  it.each<WaitReply>([
    { decision: "answer", answer: "x" },
    { decision: "continue" },
    { decision: "stop", reason: "r" },
  ])("fails on a reply not meant for a gate: $decision", (reply) => {
    expect(gateOutcome("g1", reply)).toEqual({
      status: "failed",
      reason: `unexpected reply: ${reply.decision}`,
    });
  });
});
