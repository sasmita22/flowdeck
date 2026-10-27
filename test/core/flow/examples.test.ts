import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { order } from "../../../src/core/flow/order.js";
import { NodeType, parseFlow } from "../../../src/core/flow/schema.js";

const readExample = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../../../examples/${name}`, import.meta.url), "utf8"));

describe("examples", () => {
  it("parses three-prompts.json", () => {
    expect(() => parseFlow(readExample("three-prompts.json"))).not.toThrow();
  });

  it.each([
    ["three-prompts.json", ["start", "p1", "p2", "p3", "done"]],
    ["loop-review.json", ["start", "review", "fix", "check", "done"]],
    [
      "all-types.json",
      ["start", "plan", "build", "lint", "approve", "choose", "stop", "retry", "attempt", "done"],
    ],
  ])("orders %s", (name, expected) => {
    expect(order(parseFlow(readExample(name)))).toEqual(expected);
  });

  it("uses every node type in all-types.json", () => {
    const types = parseFlow(readExample("all-types.json")).nodes.map((node) => node.type);
    expect(new Set(types)).toEqual(new Set(NodeType.options));
  });
});
