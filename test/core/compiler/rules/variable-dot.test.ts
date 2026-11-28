import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { rule } from "../../../../src/core/compiler/rules/variable-dot.js";
import { validate } from "../../../../src/core/compiler/validate.js";
import { parseFlow } from "../../../../src/core/flow/schema.js";
import { branch, flow, trigger } from "../../../fixtures/flow-builders.js";

const check = (nodes: unknown[]) => rule.check(flow(nodes, []));

describe("variable-dot", () => {
  it("reports a dotted variable name, naming the Branch, since a dot marks a library's own variable", () => {
    const errors = check([trigger("start"), { ...branch("ife2e", "a.b"), label: "E2E?" }]);

    expect(errors.map(({ rule, node, field }) => ({ rule, node, field }))).toEqual([
      { rule: "variable-dot", node: "ife2e", field: "variable" },
    ]);
    expect(errors[0]?.message).toContain("E2E?");
  });

  it("accepts a variable name without a dot", () => {
    expect(check([trigger("start"), branch("ife2e", "proceed-e2e")])).toEqual([]);
  });

  it("is the only problem in its broken fixture", () => {
    const fixture = parseFlow(
      JSON.parse(
        readFileSync(
          new URL("../../../fixtures/broken/variable-dot.json", import.meta.url),
          "utf8",
        ),
      ),
    );

    expect(validate(fixture).map(({ rule, node }) => ({ rule, node }))).toEqual([
      { rule: "variable-dot", node: "ife2e" },
    ]);
  });
});
