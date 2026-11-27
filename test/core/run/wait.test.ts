import { describe, expect, it } from "vitest";
import {
  pendingWaitSchema,
  replyFits,
  waitAnswerSchema,
  type WaitReply,
  type WaitRequest,
} from "../../../src/core/run/wait.js";
import { conditionalGate, free, gate, permission, pick } from "../../fixtures/waits.js";

const approve: WaitReply = { decision: "approve" };
const reject: WaitReply = { decision: "reject", reason: "too risky" };
const proceed: WaitReply = { decision: "continue" };
const proceedWithText: WaitReply = { decision: "continue", text: "use the v2 API" };
const stop: WaitReply = { decision: "stop", reason: "tests red" };
const blue: WaitReply = { decision: "answer", answer: "blue" };
const teal: WaitReply = { decision: "answer", answer: "teal" };

describe("pendingWaitSchema", () => {
  it.each([gate, conditionalGate, pick, free, permission])(
    "accepts a $kind wait for $nodeId",
    (request) => {
      expect(pendingWaitSchema.safeParse({ waitId: "w1", request }).success).toBe(true);
    },
  );

  it("rejects a hardstop wait", () => {
    const request = { nodeId: "h1", kind: "hardstop", shown: "", condition: "tests fail" };

    expect(pendingWaitSchema.safeParse({ waitId: "w1", request }).success).toBe(false);
  });

  it("rejects a gate wait with no instruction", () => {
    const request = { nodeId: "g1", kind: "gate", shown: "Check the plan" };

    expect(pendingWaitSchema.safeParse({ waitId: "w1", request }).success).toBe(false);
  });

  it("keeps a Conditional Gate's condition beside its instruction", () => {
    expect(pendingWaitSchema.parse({ waitId: "w1", request: conditionalGate }).request).toEqual({
      nodeId: "h1",
      kind: "gate",
      instruction: "Read the test report",
      condition: "tests fail",
    });
  });

  it("rejects a budget wait", () => {
    const request = { nodeId: "n2", kind: "budget", spend: 1.2, budget: 1 };

    expect(pendingWaitSchema.safeParse({ waitId: "w1", request }).success).toBe(false);
  });

  it("rejects a wait without a waitId", () => {
    expect(pendingWaitSchema.safeParse({ request: gate }).success).toBe(false);
  });

  it("rejects a request of an unknown kind", () => {
    expect(
      pendingWaitSchema.safeParse({ waitId: "w1", request: { nodeId: "x", kind: "vote" } }).success,
    ).toBe(false);
  });
});

describe("waitAnswerSchema", () => {
  it.each([approve, reject, proceed, stop, blue])("accepts a $decision reply", (reply) => {
    expect(waitAnswerSchema.safeParse({ waitId: "w1", reply }).success).toBe(true);
  });

  it("keeps the text typed on Continue", () => {
    expect(waitAnswerSchema.parse({ waitId: "w1", reply: proceedWithText }).reply).toEqual(
      proceedWithText,
    );
  });

  it("rejects a raise reply", () => {
    const reply = { decision: "raise", budget: 2 };

    expect(waitAnswerSchema.safeParse({ waitId: "w1", reply }).success).toBe(false);
  });

  it("accepts a reject with an empty reason", () => {
    expect(
      waitAnswerSchema.safeParse({ waitId: "w1", reply: { decision: "reject", reason: "" } })
        .success,
    ).toBe(true);
  });

  it("rejects a closed reply", () => {
    expect(
      waitAnswerSchema.safeParse({ waitId: "w1", reply: { decision: "closed" } }).success,
    ).toBe(false);
  });

  it("rejects an answer without a waitId", () => {
    expect(waitAnswerSchema.safeParse({ reply: approve }).success).toBe(false);
  });
});

describe("replyFits", () => {
  it.each<[string, boolean, WaitRequest, WaitReply]>([
    ["gate / continue", true, gate, proceed],
    ["gate / continue with text", true, gate, proceedWithText],
    ["gate / stop", true, gate, stop],
    ["gate / approve", false, gate, approve],
    ["gate / reject", false, gate, reject],
    ["gate / answer", false, gate, blue],
    ["conditional gate / continue", true, conditionalGate, proceed],
    ["conditional gate / stop", true, conditionalGate, stop],
    ["conditional gate / approve", false, conditionalGate, approve],
    ["conditional gate / answer", false, conditionalGate, blue],
    ["ask with options / one of them", true, pick, blue],
    ["ask with options / not one of them", false, pick, teal],
    ["ask with options / approve", false, pick, approve],
    ["ask with options / stop", false, pick, stop],
    ["ask without options / any text", true, free, teal],
    ["ask without options / continue", false, free, proceed],
    ["gate / closed", false, gate, { decision: "closed" }],
    ["permission / approve", true, permission, approve],
    ["permission / reject", true, permission, reject],
    ["permission / answer", false, permission, blue],
  ])("%s fits: %s", (_name, fits, request, reply) => {
    expect(replyFits(request, reply)).toBe(fits);
  });
});
