import { describe, expect, it } from "vitest";
import { rule } from "../../../../src/core/compiler/rules/references.js";
import { agent, flow, loop, thenWire } from "../../../fixtures/flow-builders.js";

const errorsFor = (nodes: unknown[], wires: unknown[]) =>
  rule
    .check(flow(nodes, wires))
    .map(({ rule, wire, node, field }) => ({ rule, wire, node, field }));

describe("references", () => {
  it("reports a wire from a missing node", () => {
    expect(errorsFor([agent("A")], [thenWire("ghost", "A")])).toEqual([
      { rule: "references", wire: 0, node: undefined, field: "from" },
    ]);
  });

  it("reports a wire to a missing node", () => {
    expect(errorsFor([agent("A")], [thenWire("A", "ghost")])).toEqual([
      { rule: "references", wire: 0, node: undefined, field: "to" },
    ]);
  });

  it("reports a parent that names no node", () => {
    expect(errorsFor([agent("A", { parent: "ghost" })], [])).toEqual([
      { rule: "references", wire: undefined, node: "A", field: "parent" },
    ]);
  });

  it("accepts wires and parents that name nodes in the flow", () => {
    expect(
      errorsFor([agent("A"), loop("L"), agent("X", { parent: "L" })], [thenWire("A", "X")]),
    ).toEqual([]);
  });
});
