import { describe, expect, it } from "vitest";
import {
  pendingWaitSchema,
  replyFits,
  waitAnswerSchema,
  type WaitReply,
  type WaitRequest,
} from "../../../src/core/run/wait.js";
import {
  budget,
  free,
  gate,
  hardstop,
  permission,
  pick,
  unconfirmedBudget,
} from "../../fixtures/waits.js";

const approve: WaitReply = { decision: "approve" };
const reject: WaitReply = { decision: "reject", reason: "too risky" };
const proceed: WaitReply = { decision: "continue" };
const stop: WaitReply = { decision: "stop", reason: "tests red" };
const blue: WaitReply = { decision: "answer", answer: "blue" };
const teal: WaitReply = { decision: "answer", answer: "teal" };
const raise = (amount: number): WaitReply => ({ decision: "raise", budget: amount });

describe("pendingWaitSchema", () => {
  it.each([gate, hardstop, pick, free, permission, budget])(
    "accepts a $kind wait for $nodeId",
    (request) => {
      expect(pendingWaitSchema.safeParse({ waitId: "w1", request }).success).toBe(true);
    },
  );

  it("keeps an unconfirmed budget wait's flag", () => {
    const parsed = pendingWaitSchema.parse({ waitId: "w1", request: unconfirmedBudget });

    expect(parsed.request).toEqual(unconfirmedBudget);
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
  it.each([approve, reject, proceed, stop, blue, raise(2)])(
    "accepts a $decision reply",
    (reply) => {
      expect(waitAnswerSchema.safeParse({ waitId: "w1", reply }).success).toBe(true);
    },
  );

  it.each([0, -1])("rejects a raise to %s", (amount) => {
    expect(waitAnswerSchema.safeParse({ waitId: "w1", reply: raise(amount) }).success).toBe(false);
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
    ["gate / approve", true, gate, approve],
    ["gate / reject", true, gate, reject],
    ["gate / continue", false, gate, proceed],
    ["gate / stop", false, gate, stop],
    ["gate / answer", false, gate, blue],
    ["hardstop / continue", true, hardstop, proceed],
    ["hardstop / stop", true, hardstop, stop],
    ["hardstop / approve", false, hardstop, approve],
    ["hardstop / reject", false, hardstop, reject],
    ["hardstop / answer", false, hardstop, blue],
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
    ["budget / stop", true, budget, stop],
    ["budget / raise above the spend", true, budget, raise(2)],
    ["budget / raise equal to the spend", false, budget, raise(1.2)],
    ["budget / raise below the spend", false, budget, raise(1)],
    ["budget / approve", false, budget, approve],
  ])("%s fits: %s", (_name, fits, request, reply) => {
    expect(replyFits(request, reply)).toBe(fits);
  });
});
