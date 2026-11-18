import { describe, expect, it } from "vitest";
import { rule } from "../../../../src/core/compiler/rules/variable-kind.js";
import { agent, branch, onMainFlow, thenWire } from "../../../fixtures/flow-builders.js";

const instructed = (id: string, instructions: string) => agent(id, { settings: { instructions } });

describe("variable-kind", () => {
  it("reports a name used as both yes/no and text once, naming the variable and both nodes", () => {
    const errors = rule.check(
      onMainFlow(
        [branch("decide", "x"), instructed("plan", "Plan {{x}}.")],
        [thenWire("decide", "plan")],
      ),
    );

    expect(errors.map(({ rule }) => rule)).toEqual(["variable-kind"]);
    expect(errors[0]?.message).toContain('"x"');
    expect(errors[0]?.message).toContain("decide");
    expect(errors[0]?.message).toContain("plan");
  });

  it("accepts a yes/no and a text variable with different names", () => {
    expect(
      rule.check(
        onMainFlow(
          [branch("decide", "ship"), instructed("plan", "Plan {{ticket}}.")],
          [thenWire("decide", "plan")],
        ),
      ),
    ).toEqual([]);
  });
});
