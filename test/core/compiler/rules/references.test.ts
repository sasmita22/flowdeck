import { describe, expect, it } from "vitest";
import { rule } from "../../../../src/core/compiler/rules/references.js";
import { flow, loop, prompt, thenWire } from "../../../fixtures/flow-builders.js";

const errorsFor = (nodes: unknown[], wires: unknown[]) =>
  rule
    .check(flow(nodes, wires))
    .map(({ rule, wire, node, field }) => ({ rule, wire, node, field }));

describe("references", () => {
  it("reports a wire from a missing node", () => {
    expect(errorsFor([prompt("A")], [thenWire("ghost", "A")])).toEqual([
      { rule: "references", wire: 0, node: undefined, field: "from" },
    ]);
  });

  it("reports a wire to a missing node", () => {
    expect(errorsFor([prompt("A")], [thenWire("A", "ghost")])).toEqual([
      { rule: "references", wire: 0, node: undefined, field: "to" },
    ]);
  });

  it("reports a parent that names no node", () => {
    expect(errorsFor([prompt("A", { parent: "ghost" })], [])).toEqual([
      { rule: "references", wire: undefined, node: "A", field: "parent" },
    ]);
  });

  it("accepts wires and parents that name nodes in the flow", () => {
    expect(
      errorsFor([prompt("A"), loop("L"), prompt("X", { parent: "L" })], [thenWire("A", "X")]),
    ).toEqual([]);
  });
});
