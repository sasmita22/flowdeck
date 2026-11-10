import { describe, expect, it } from "vitest";
import { rule } from "../../../../src/core/compiler/rules/undeclared-variable.js";
import type { BuildConfig } from "../../../../src/core/flow/schema.js";
import { agent, ask, flow, gate } from "../../../fixtures/flow-builders.js";

const check = (nodes: unknown[], variables: BuildConfig["variables"] = []) => {
  const base = flow(nodes, []);
  return rule.check({ ...base, session: { ...base.session, buildConfig: { variables } } });
};

describe("undeclared-variable", () => {
  it("reports an agent using an undeclared variable, naming the node and the variable", () => {
    const node = agent("fix", { settings: { instructions: "Fix {{x}}." } });
    const errors = check([node], [{ name: "ticket", kind: "text" }]);

    expect(errors.map(({ rule, node }) => ({ rule, node }))).toEqual([
      { rule: "undeclared-variable", node: "fix" },
    ]);
    expect(errors[0]?.message).toContain("x");
  });

  it("accepts declared variables", () => {
    expect(
      check(
        [
          agent("fix", { settings: { instructions: "Fix {{ticket}}." } }),
          agent("check", { settings: { instructions: "Run e2e: {{ e2e }}" } }),
        ],
        [
          { name: "ticket", kind: "text" },
          { name: "e2e", kind: "yesno" },
        ],
      ),
    ).toEqual([]);
  });

  it("names only Agents in its rule message", () => {
    expect(rule.message).toBe(
      "Every {{name}} in an Agent must be a variable declared in Build configuration.",
    );
  });

  it("does not scan nodes other than Agent", () => {
    expect(
      check([
        ask("run", { settings: { question: "{{x}}?", options: ["yes", "no"] } }),
        gate("look", { settings: { shown: "{{x}}", skippable: false } }),
      ]),
    ).toEqual([]);
  });
});
