import { describe, expect, it } from "vitest";
import { rule } from "../../../../src/core/compiler/rules/variable-names.js";
import { agent, branch, onMainFlow, thenWire } from "../../../fixtures/flow-builders.js";

const instructed = (id: string, instructions: string) => agent(id, { settings: { instructions } });

describe("variable-names", () => {
  it("accepts found names made of letters, digits, dashes and underscores", () => {
    expect(
      rule.check(
        onMainFlow(
          [branch("decide", "proceed-e2e"), instructed("plan", "Plan {{ticket}} and {{step_2}}.")],
          [thenWire("decide", "plan")],
        ),
      ),
    ).toEqual([]);
  });

  it.each(["a b", "-x", "a..b"])("reports the bad name {{%s}} in an Agent, naming it", (name) => {
    const errors = rule.check(
      onMainFlow([instructed("plan", `Plan {{ticket}} and {{${name}}}.`)], []),
    );

    expect(errors.map(({ rule }) => rule)).toEqual(["variable-names"]);
    expect(errors[0]?.message).toContain(`"${name}"`);
  });

  it("says a name may join parts with dots, in the rule and in each report", () => {
    const errors = rule.check(onMainFlow([branch("decide", "a..b")], []));

    expect(rule.message).toMatch(/\bdots?\b/);
    expect(errors[0]?.message).toMatch(/\bdots?\b/);
  });

  it.each(["a b", "-x", "a..b"])("reports the bad Branch variable name %j, naming it", (name) => {
    const errors = rule.check(onMainFlow([branch("decide", name)], []));

    expect(errors.map(({ rule }) => rule)).toEqual(["variable-names"]);
    expect(errors[0]?.message).toContain(`"${name}"`);
  });
});
