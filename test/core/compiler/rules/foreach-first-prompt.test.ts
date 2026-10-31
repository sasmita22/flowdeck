import { describe, expect, it } from "vitest";
import { rule } from "../../../../src/core/compiler/rules/foreach-first-prompt.js";
import { agent, flow, forEach, gate, prompt, script } from "../../../fixtures/flow-builders.js";

const inE1 = { parent: "e1" };
const check = (nodes: unknown[]) => rule.check(flow(nodes, []));

describe("foreach-first-prompt", () => {
  it("reports a body whose first turn is an agent, naming both", () => {
    const errors = check([forEach("e1"), agent("a1", inE1), prompt("p1", inE1)]);

    expect(errors.map(({ rule, node }) => ({ rule, node }))).toEqual([
      { rule: "foreach-first-prompt", node: "e1" },
    ]);
    expect(errors[0]?.message).toContain("e1 (foreach)");
    expect(errors[0]?.message).toContain("a1");
  });

  it("accepts a script before the first prompt", () => {
    expect(check([forEach("e1"), script("s1", inE1), prompt("p1", inE1)])).toEqual([]);
  });

  it("reports a body with no prompt or agent", () => {
    const errors = check([forEach("e1"), script("s1", inE1), gate("g1", inE1)]);

    expect(errors.map(({ rule, node }) => ({ rule, node }))).toEqual([
      { rule: "foreach-first-prompt", node: "e1" },
    ]);
    expect(errors[0]?.message).toContain("has no prompt in its body");
  });

  it("accepts a flow with no for each", () => {
    expect(check([agent("a1"), prompt("p1")])).toEqual([]);
  });
});
