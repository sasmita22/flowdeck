import { describe, expect, it } from "vitest";
import {
  pendingWaitSchema,
  replyFits,
  waitAnswerSchema,
  type WaitReply,
  type WaitRequest,
} from "../../../src/core/run/wait.js";
import { free, gate, hardstop, pick } from "../../fixtures/waits.js";

const approve: WaitReply = { decision: "approve" };
const reject: WaitReply = { decision: "reject", reason: "too risky" };
const proceed: WaitReply = { decision: "continue" };
const stop: WaitReply = { decision: "stop", reason: "tests red" };
const blue: WaitReply = { decision: "answer", answer: "blue" };
const teal: WaitReply = { decision: "answer", answer: "teal" };

describe("pendingWaitSchema", () => {
  it.each([gate, hardstop, pick, free])("accepts a $kind wait for $nodeId", (request) => {
    expect(pendingWaitSchema.safeParse({ waitId: "w1", request }).success).toBe(true);
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
  ])("%s fits: %s", (_name, fits, request, reply) => {
    expect(replyFits(request, reply)).toBe(fits);
  });
});
