import { describe, expect, it } from "vitest";
import {
  decisionsOf,
  loopRound,
  nodeStatus,
  roundItems,
  type RunEvent,
} from "../../../src/core/run/run-events.js";
import { IllegalMoveError } from "../../../src/core/run/state.js";

const sent: RunEvent = { kind: "sent" };
const running: RunEvent = { kind: "running" };
const retry: RunEvent = { kind: "retry" };
const needsYou: RunEvent = { kind: "needs-you" };
const done: RunEvent = { kind: "done" };
const skipped: RunEvent = { kind: "skipped" };
const reset: RunEvent = { kind: "reset" };
const failed: RunEvent = { kind: "failed", payload: { message: "exit code 1" } };
const round = (n: number): RunEvent => ({ kind: "round", payload: { round: n } });

describe("nodeStatus", () => {
  it.each<[string, RunEvent[], string]>([
    ["no events", [], "waiting"],
    ["sent then done", [sent, done], "done"],
    ["a retried script that fails", [running, retry, running, failed], "failed"],
    ["a done node reset for the next round", [sent, done, reset], "waiting"],
    ["a skipped node reset for the next round", [skipped, reset], "waiting"],
    [
      "a decision while waiting on a human",
      [needsYou, { kind: "decided", payload: { nodeId: "g1", decision: "approved" } }],
      "needs-you",
    ],
    [
      "an answer while waiting on a human",
      [
        needsYou,
        { kind: "answered", payload: { nodeId: "q1", decision: "answered", answer: "blue" } },
      ],
      "needs-you",
    ],
    ["a round on a running loop", [running, round(1)], "running"],
  ])("folds %s to its status", (_name, events, status) => {
    expect(nodeStatus(events)).toBe(status);
  });

  it("throws on a move the transitions table forbids", () => {
    expect(() => nodeStatus([done])).toThrow(IllegalMoveError);
  });
});

describe("loopRound", () => {
  it("is the number of the last round event", () => {
    expect(loopRound([running, round(1), round(2)])).toBe(2);
  });

  it("is 0 before any round", () => {
    expect(loopRound([running])).toBe(0);
  });
});

describe("roundItems", () => {
  const withItems = (n: number, items: string[]): RunEvent => ({
    kind: "round",
    payload: { round: n, items },
  });

  it("is the items of the first round event that carries them", () => {
    expect(roundItems([running, withItems(1, ["alpha", "bravo"]), round(2)])).toEqual([
      "alpha",
      "bravo",
    ]);
  });

  it("is undefined when no round event carries items", () => {
    expect(roundItems([running, round(1), round(2)])).toBeUndefined();
  });

  it("leaves loopRound counting rounds that carry items", () => {
    expect(loopRound([running, withItems(1, ["alpha", "bravo"]), round(2)])).toBe(2);
  });
});

describe("decisionsOf", () => {
  it("projects decisions and answers in event order, ignoring other kinds", () => {
    const events: RunEvent[] = [
      needsYou,
      { kind: "answered", payload: { nodeId: "q1", decision: "answered", answer: "blue" } },
      done,
      sent,
      done,
      { kind: "decided", payload: { nodeId: "g1", decision: "rejected", reason: "no" } },
      failed,
    ];

    expect(decisionsOf(events)).toEqual([
      { nodeId: "q1", decision: "answered", answer: "blue" },
      { nodeId: "g1", decision: "rejected", reason: "no" },
    ]);
  });
});
