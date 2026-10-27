import { describe, expect, it } from "vitest";
import { rule } from "../../../../src/core/compiler/rules/no-cycle.js";
import { flow, prompt, thenWire } from "../../../fixtures/flow-builders.js";

describe("no-cycle", () => {
  it("reports each node of a cycle without throwing", () => {
    const cyclic = flow([prompt("a"), prompt("b")], [thenWire("a", "b"), thenWire("b", "a")]);
    expect(rule.check(cyclic).map(({ rule, node }) => ({ rule, node }))).toEqual([
      { rule: "no-cycle", node: "a" },
      { rule: "no-cycle", node: "b" },
    ]);
  });

  it("accepts an acyclic flow", () => {
    expect(rule.check(flow([prompt("a"), prompt("b")], [thenWire("a", "b")]))).toEqual([]);
  });
});
