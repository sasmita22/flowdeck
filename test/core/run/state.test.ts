import { describe, expect, it } from "vitest";
import { IllegalMoveError, move, type NodeState } from "../../../src/core/run/state.js";

const states: NodeState[] = ["waiting", "sent", "running", "needs-you", "failed", "done"];

const legal: [NodeState, NodeState][] = [
  ["waiting", "sent"],
  ["sent", "done"],
  ["sent", "failed"],
  ["waiting", "running"],
  ["running", "done"],
  ["running", "failed"],
  ["running", "waiting"],
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

  it("allows no move into or out of needs-you", () => {
    const touchingNeedsYou = illegal.filter(
      ([from, to]) => from === "needs-you" || to === "needs-you",
    );

    expect(touchingNeedsYou).toHaveLength(states.length * 2 - 1);
  });
});
