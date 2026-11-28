import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { rule } from "../../../../src/core/compiler/rules/produce-rows.js";
import { validate } from "../../../../src/core/compiler/validate.js";
import { parseFlow } from "../../../../src/core/flow/schema.js";
import { agent, onMainFlow } from "../../../fixtures/flow-builders.js";

const producing = (...produces: { variable: string; yesIf: string; noIf: string }[]) => ({
  ...agent("review", { settings: { produces } }),
  label: "Reviewer",
});

const check = (...produces: { variable: string; yesIf: string; noIf: string }[]) =>
  rule.check(onMainFlow([producing(...produces)], []));

describe("produce-rows", () => {
  it.each([
    ["Yes if", { variable: "approved", yesIf: "", noIf: "tests fail" }],
    ["No if", { variable: "approved", yesIf: "tests pass", noIf: "" }],
  ])("reports a row with no %s on the Agent, naming the variable and the field", (field, row) => {
    const errors = check(row);

    expect(errors.map(({ rule: id, node }) => ({ rule: id, node }))).toEqual([
      { rule: "produce-rows", node: "review" },
    ]);
    expect(errors[0]?.message).toContain('"approved"');
    expect(errors[0]?.message).toContain(field);
    expect(errors[0]?.message).toContain("Reviewer");
  });

  it("reports a row missing both conditions once", () => {
    expect(check({ variable: "approved", yesIf: "", noIf: "" })).toHaveLength(1);
  });

  it("accepts a row once both conditions are filled", () => {
    expect(check({ variable: "approved", yesIf: "tests pass", noIf: "tests fail" })).toEqual([]);
  });

  it("reports a row with no variable picked yet", () => {
    const errors = check({ variable: "", yesIf: "tests pass", noIf: "tests fail" });

    expect(errors.map(({ rule: id, node }) => ({ rule: id, node }))).toEqual([
      { rule: "produce-rows", node: "review" },
    ]);
  });

  it("reports each incomplete row of one Agent", () => {
    expect(
      check(
        { variable: "approved", yesIf: "", noIf: "tests fail" },
        { variable: "docs", yesIf: "docs changed", noIf: "docs did not change" },
        { variable: "", yesIf: "", noIf: "" },
      ),
    ).toHaveLength(2);
  });

  it("accepts an Agent with no produce rows", () => {
    expect(rule.check(onMainFlow([agent("plan")], []))).toEqual([]);
  });

  it("is the only problem in its broken fixture", () => {
    const fixture = parseFlow(
      JSON.parse(
        readFileSync(
          new URL("../../../fixtures/broken/produce-rows.json", import.meta.url),
          "utf8",
        ),
      ),
    );

    expect(validate(fixture).map(({ rule: id, node }) => ({ rule: id, node }))).toEqual([
      { rule: "produce-rows", node: "review" },
    ]);
  });
});
