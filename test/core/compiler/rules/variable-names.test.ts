import { describe, expect, it } from "vitest";
import { rule } from "../../../../src/core/compiler/rules/variable-names.js";
import type { BuildConfig } from "../../../../src/core/flow/schema.js";
import { flow, prompt } from "../../../fixtures/flow-builders.js";

const check = (variables: BuildConfig["variables"]) => {
  const base = flow([prompt("p")], []);
  return rule.check({ ...base, session: { ...base.session, buildConfig: { variables } } });
};

describe("variable-names", () => {
  it("accepts unique names made of letters, digits, dashes and underscores", () => {
    expect(
      check([
        { name: "ticket", kind: "text" },
        { name: "proceed-e2e", kind: "yesno" },
      ]),
    ).toEqual([]);
  });

  it.each(["-x", "a b", ""])("reports the bad name %j, naming it", (name) => {
    const errors = check([
      { name: "ticket", kind: "text" },
      { name, kind: "text" },
    ]);

    expect(errors.map(({ rule }) => rule)).toEqual(["variable-names"]);
    expect(errors[0]?.message).toContain(`"${name}"`);
  });

  it("reports a name declared twice, naming it", () => {
    const errors = check([
      { name: "ticket", kind: "text" },
      { name: "ticket", kind: "yesno" },
    ]);

    expect(errors.map(({ rule }) => rule)).toEqual(["variable-names"]);
    expect(errors[0]?.message).toContain("ticket");
  });
});
