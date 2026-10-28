import { describe, expect, it } from "vitest";
import { IllegalMoveError, move, type NodeState } from "../../../src/core/run/state.js";

const states: NodeState[] = [
  "waiting",
  "sent",
  "running",
  "needs-you",
  "skipped",
  "failed",
  "done",
];

const legal: [NodeState, NodeState][] = [
  ["waiting", "sent"],
  ["sent", "done"],
  ["sent", "failed"],
  ["waiting", "running"],
  ["running", "done"],
  ["running", "failed"],
  ["running", "waiting"],
  ["waiting", "needs-you"],
  ["waiting", "skipped"],
  ["needs-you", "done"],
  ["needs-you", "failed"],
];

const isLegal = (from: NodeState, to: NodeState) => legal.some(([a, b]) => a === from && b === to);

const illegal = states.flatMap((from) =>
  states.filter((to) => !isLegal(from, to)).map((to): [NodeState, NodeState] => [from, to]),
);

describe("move", () => {
  it.each(legal)("allows %s to %s", (from, to) => {
    expect(move(from, to)).toBe(to);
  });

  it("refuses done to running, naming both states", () => {
    expect(() => move("done", "running")).toThrow(IllegalMoveError);
    expect(() => move("done", "running")).toThrow(/done.*running/);
  });

  it("covers every ordered pair of states", () => {
    expect(illegal).toHaveLength(states.length * states.length - legal.length);
  });

  it.each(illegal)("refuses %s to %s", (from, to) => {
    expect(() => move(from, to)).toThrow(IllegalMoveError);
    expect(() => move(from, to)).toThrow(`${from}`);
    expect(() => move(from, to)).toThrow(`${to}`);
  });

  it("enters needs-you only from waiting and leaves it only to done or failed", () => {
    const intoNeedsYou = legal.filter(([, to]) => to === "needs-you").map(([from]) => from);
    const outOfNeedsYou = legal.filter(([from]) => from === "needs-you").map(([, to]) => to);

    expect(intoNeedsYou).toEqual(["waiting"]);
    expect(outOfNeedsYou).toEqual(["done", "failed"]);
    for (const state of states.filter((s) => s !== "waiting")) {
      expect(() => move(state, "needs-you")).toThrow(IllegalMoveError);
    }
    for (const state of states.filter((s) => s !== "done" && s !== "failed")) {
      expect(() => move("needs-you", state)).toThrow(IllegalMoveError);
    }
  });
});
