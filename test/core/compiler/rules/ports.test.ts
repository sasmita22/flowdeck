import { describe, expect, it } from "vitest";
import { rule } from "../../../../src/core/compiler/rules/ports.js";
import { flow, output, prompt, thenWire, trigger, wire } from "../../../fixtures/flow-builders.js";

const errorsFor = (nodes: unknown[], wires: unknown[]) =>
  rule.check(flow(nodes, wires)).map(({ rule, wire, node }) => ({ rule, wire, node }));

describe("ports", () => {
  it("reports a wire into a trigger", () => {
    expect(
      errorsFor([trigger("T"), prompt("P")], [thenWire("T", "P"), thenWire("P", "T")]),
    ).toEqual([{ rule: "ports", wire: 1, node: "T" }]);
  });

  it("reports a wire out of an output", () => {
    expect(errorsFor([output("O"), prompt("P")], [thenWire("O", "P")])).toEqual([
      { rule: "ports", wire: 0, node: "O" },
    ]);
  });

  it("reports a wire leaving from an input port at its source", () => {
    expect(errorsFor([prompt("A"), prompt("B")], [wire("A", "in", "B", "in")])).toEqual([
      { rule: "ports", wire: 0, node: "A" },
    ]);
  });

  it("reports a wire arriving at an output port at its target", () => {
    expect(errorsFor([prompt("A"), prompt("B")], [wire("A", "out", "B", "out")])).toEqual([
      { rule: "ports", wire: 0, node: "B" },
    ]);
  });

  it("leaves a wire to a missing node to the references rule", () => {
    expect(errorsFor([prompt("A")], [thenWire("A", "ghost")])).toEqual([]);
  });

  it("accepts trigger to prompt to output", () => {
    expect(
      errorsFor([trigger("T"), prompt("P"), output("O")], [thenWire("T", "P"), thenWire("P", "O")]),
    ).toEqual([]);
  });
});
