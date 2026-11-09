import { describe, expect, it } from "vitest";
import { flowProblems } from "../../../src/core/compiler/flow-problems.js";
import {
  agent,
  flow,
  output,
  prompt,
  thenWire,
  trigger,
  wire,
} from "../../fixtures/flow-builders.js";

const blankAgent = agent("blank", { settings: { instructions: "" } });
const ruleAndNode = (problems: ReturnType<typeof flowProblems>) =>
  problems.map(({ rule, node }) => ({ rule, node }));

describe("flowProblems", () => {
  it("raises nothing for a blank Agent off the main flow", () => {
    const loose = flow(
      [trigger("start"), prompt("a"), output("stop"), blankAgent],
      [thenWire("start", "a"), thenWire("a", "stop")],
    );

    expect(flowProblems(loose)).toEqual([]);
  });

  it("raises the blank Agent's settings once it is on the main flow", () => {
    const wired = flow(
      [trigger("start"), prompt("a"), output("stop"), blankAgent],
      [thenWire("start", "a"), thenWire("a", "blank"), thenWire("blank", "stop")],
    );

    expect(ruleAndNode(flowProblems(wired))).toEqual([
      { rule: "required-settings", node: "blank" },
    ]);
  });

  it("raises every problem in the flow when it has no Start", () => {
    const noStart = flow([prompt("a"), output("stop"), blankAgent], [thenWire("a", "stop")]);

    expect(ruleAndNode(flowProblems(noStart))).toEqual(
      expect.arrayContaining([
        { rule: "one-start", node: undefined },
        { rule: "required-settings", node: "blank" },
      ]),
    );
  });

  it("raises one-start when a second Start is loose", () => {
    const twoStarts = flow(
      [trigger("start"), trigger("other"), prompt("a"), output("stop")],
      [thenWire("start", "a"), thenWire("a", "stop")],
    );

    expect(flowProblems(twoStarts).map(({ rule }) => rule)).toContain("one-start");
  });

  it("raises stop-required when the only Stop is loose", () => {
    const looseStop = flow(
      [trigger("start"), prompt("a"), output("stop")],
      [thenWire("start", "a")],
    );

    expect(flowProblems(looseStop).map(({ rule }) => rule)).toContain("stop-required");
  });

  it("numbers a problem's wire by its place in the whole flow, loose wires included", () => {
    const looseWireFirst = flow(
      [trigger("start"), prompt("a"), output("stop"), prompt("x"), prompt("y")],
      [
        thenWire("x", "y"),
        thenWire("start", "a"),
        wire("a", "out", "stop", "bogus"),
        thenWire("a", "stop"),
      ],
    );

    expect(flowProblems(looseWireFirst)).toEqual([
      expect.objectContaining({ rule: "ports", node: "stop", wire: 2 }),
    ]);
  });
});
