import { describe, expect, it } from "vitest";
import { rule } from "../../../../src/core/compiler/rules/loop-single-entry.js";
import { agent, flow, loop, thenWire } from "../../../fixtures/flow-builders.js";

const nodes = [
  agent("A"),
  agent("B"),
  loop("L"),
  agent("X", { parent: "L" }),
  agent("Y", { parent: "L" }),
];

describe("loop-single-entry", () => {
  it("reports a loop body entered at two nodes from outside", () => {
    const errors = rule.check(flow(nodes, [thenWire("A", "X"), thenWire("B", "Y")]));
    expect(errors.map(({ rule, node }) => ({ rule, node }))).toEqual([
      { rule: "loop-single-entry", node: "L" },
    ]);
    expect(errors[0]?.message).toContain("X");
    expect(errors[0]?.message).toContain("Y");
  });

  it("counts a wire from the loop node as an entry", () => {
    const errors = rule.check(flow(nodes, [thenWire("L", "X"), thenWire("A", "Y")]));
    expect(errors.map(({ rule, node }) => ({ rule, node }))).toEqual([
      { rule: "loop-single-entry", node: "L" },
    ]);
  });

  it("accepts a body with one entry and internal wires", () => {
    expect(
      rule.check(flow(nodes, [thenWire("A", "X"), thenWire("X", "Y"), thenWire("Y", "X")])),
    ).toEqual([]);
  });
});
