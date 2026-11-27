import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { rule } from "../../../../src/core/compiler/rules/gate-condition.js";
import { validate } from "../../../../src/core/compiler/validate.js";
import { parseFlow } from "../../../../src/core/flow/schema.js";
import { gate, onMainFlow } from "../../../fixtures/flow-builders.js";

const reported = (settings: Record<string, unknown>) =>
  rule.check(onMainFlow([gate("g", { settings })], [])).map(({ rule, node, field }) => ({
    rule,
    node,
    field,
  }));

describe("gate-condition", () => {
  it.each(["", "   "])("refuses a Conditional Gate whose condition is %j", (condition) => {
    expect(reported({ stopWhen: "conditional", condition })).toEqual([
      { rule: "gate-condition", node: "g", field: "condition" },
    ]);
  });

  it("accepts a Conditional Gate with a condition", () => {
    expect(reported({ stopWhen: "conditional", condition: "tests fail" })).toEqual([]);
  });

  it("accepts an Always Gate with no condition", () => {
    expect(reported({ stopWhen: "always", condition: "" })).toEqual([]);
  });

  it("names the Gate in its message", () => {
    const [problem] = rule.check(
      onMainFlow(
        [{ ...gate("g", { settings: { stopWhen: "conditional" } }), label: "Review" }],
        [],
      ),
    );

    expect(problem?.message).toContain("Review");
  });

  it("is the only problem in its broken fixture", () => {
    const fixture = parseFlow(
      JSON.parse(
        readFileSync(
          new URL("../../../fixtures/broken/gate-condition.json", import.meta.url),
          "utf8",
        ),
      ),
    );

    expect(validate(fixture).map(({ rule, node }) => ({ rule, node }))).toEqual([
      { rule: "gate-condition", node: "check" },
    ]);
  });
});
