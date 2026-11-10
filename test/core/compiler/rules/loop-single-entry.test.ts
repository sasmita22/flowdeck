import { describe, expect, it } from "vitest";
import { rule } from "../../../../src/core/compiler/rules/loop-single-entry.js";
import { agent, flow, forEach, loop, thenWire } from "../../../fixtures/flow-builders.js";

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

  describe("for each bodies", () => {
    const eachNodes = [
      agent("A"),
      agent("B"),
      forEach("E"),
      agent("X", { parent: "E" }),
      agent("Y", { parent: "E" }),
    ];

    it("reports a for each body entered at two nodes, naming it as a for each", () => {
      const errors = rule.check(flow(eachNodes, [thenWire("A", "X"), thenWire("B", "Y")]));
      expect(errors.map(({ rule, node }) => ({ rule, node }))).toEqual([
        { rule: "loop-single-entry", node: "E" },
      ]);
      expect(errors[0]?.message).toContain("E (foreach)");
      expect(errors[0]?.message).toContain("X");
      expect(errors[0]?.message).toContain("Y");
    });

    it("accepts a for each body with one entry", () => {
      expect(rule.check(flow(eachNodes, [thenWire("A", "X"), thenWire("X", "Y")]))).toEqual([]);
    });
  });
});
