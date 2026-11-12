import { describe, expect, it } from "vitest";
import { rule } from "../../../../src/core/compiler/rules/ports.js";
import { agent, flow, output, thenWire, trigger, wire } from "../../../fixtures/flow-builders.js";

const errorsFor = (nodes: unknown[], wires: unknown[]) =>
  rule.check(flow(nodes, wires)).map(({ rule, wire, node }) => ({ rule, wire, node }));

describe("ports", () => {
  it("reports a wire into a trigger", () => {
    expect(errorsFor([trigger("T"), agent("P")], [thenWire("T", "P"), thenWire("P", "T")])).toEqual(
      [{ rule: "ports", wire: 1, node: "T" }],
    );
  });

  it("reports a wire out of an output", () => {
    expect(errorsFor([output("O"), agent("P")], [thenWire("O", "P")])).toEqual([
      { rule: "ports", wire: 0, node: "O" },
    ]);
  });

  it("reports a wire leaving from an input port at its source", () => {
    expect(errorsFor([agent("A"), agent("B")], [wire("A", "in", "B", "in")])).toEqual([
      { rule: "ports", wire: 0, node: "A" },
    ]);
  });

  it("reports a wire arriving at an output port at its target", () => {
    expect(errorsFor([agent("A"), agent("B")], [wire("A", "out", "B", "out")])).toEqual([
      { rule: "ports", wire: 0, node: "B" },
    ]);
  });

  it("leaves a wire to a missing node to the references rule", () => {
    expect(errorsFor([agent("A")], [thenWire("A", "ghost")])).toEqual([]);
  });

  it("accepts trigger to agent to output", () => {
    expect(
      errorsFor([trigger("T"), agent("P"), output("O")], [thenWire("T", "P"), thenWire("P", "O")]),
    ).toEqual([]);
  });

  it("reports a wire to the old file ports as ports the Agent does not have", () => {
    const errors = rule.check(
      flow([agent("A"), agent("B")], [wire("A", "file-out", "B", "file-in")]),
    );

    expect(errors.map(({ node, message }) => ({ node, message }))).toEqual([
      { node: "A", message: 'agent "A" has no output port "file-out".' },
      { node: "B", message: 'agent "B" has no input port "file-in".' },
    ]);
  });

  it("reports an Event wire drawn between Then ports, on both ends, in plain words", () => {
    const eventOnThen = { ...thenWire("A", "B"), kind: "event" };
    const errors = rule.check(flow([agent("A"), agent("B")], [eventOnThen]));

    expect(errors.map(({ node, message }) => ({ node, message }))).toEqual([
      { node: "A", message: 'agent "A" port "out" takes Then wires, not Event wires.' },
      { node: "B", message: 'agent "B" port "in" takes Then wires, not Event wires.' },
    ]);
  });
});
