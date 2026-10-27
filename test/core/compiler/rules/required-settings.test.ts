import { describe, expect, it } from "vitest";
import { rule } from "../../../../src/core/compiler/rules/required-settings.js";
import { agent, flow, script } from "../../../fixtures/flow-builders.js";

const errorsFor = (node: unknown) =>
  rule.check(flow([node], [])).map(({ rule, node, field }) => ({ rule, node, field }));

describe("required-settings", () => {
  it.each(["", "  \n\t"])("reports an agent whose instructions are %j", (instructions) => {
    expect(errorsFor(agent("A", { settings: { instructions } }))).toEqual([
      { rule: "required-settings", node: "A", field: "instructions" },
    ]);
  });

  it("accepts an agent with instructions", () => {
    expect(errorsFor(agent("A", { settings: { instructions: "Build it." } }))).toEqual([]);
  });

  it("does not require text on other node types", () => {
    expect(errorsFor(script("S", { settings: { command: "" } }))).toEqual([]);
  });
});
