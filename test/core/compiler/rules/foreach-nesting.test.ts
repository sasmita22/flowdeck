import { describe, expect, it } from "vitest";
import { rule } from "../../../../src/core/compiler/rules/foreach-nesting.js";
import { flow, forEach, loop, prompt } from "../../../fixtures/flow-builders.js";

const check = (nodes: unknown[]) => rule.check(flow(nodes, []));

describe("foreach-nesting", () => {
  it.each([
    [
      "a for each inside a loop",
      [loop("L"), { ...forEach("E"), parent: "L" }],
      "E (foreach)",
      "L (loop)",
    ],
    [
      "a for each inside a for each",
      [forEach("O"), { ...forEach("E"), parent: "O" }],
      "E (foreach)",
      "O (foreach)",
    ],
    [
      "a loop inside a for each",
      [forEach("O"), loop("L", { parent: "O" })],
      "L (loop)",
      "O (foreach)",
    ],
  ])("reports %s, naming child and parent", (_, nodes, child, parent) => {
    const errors = check(nodes);

    expect(errors.map(({ rule }) => rule)).toEqual(["foreach-nesting"]);
    expect(errors[0]?.node).toBe(child.split(" ")[0]);
    expect(errors[0]?.message).toContain(child);
    expect(errors[0]?.message).toContain(parent);
  });

  it("accepts a top-level for each", () => {
    expect(check([forEach("E"), prompt("p1", { parent: "E" })])).toEqual([]);
  });

  it("accepts a loop and a for each side by side", () => {
    expect(
      check([
        loop("L"),
        prompt("l1", { parent: "L" }),
        forEach("E"),
        prompt("e1", { parent: "E" }),
      ]),
    ).toEqual([]);
  });
});
