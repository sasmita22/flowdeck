import { describe, expect, it } from "vitest";
import { rule } from "../../../../src/core/compiler/rules/undeclared-variable.js";
import type { BuildConfig } from "../../../../src/core/flow/schema.js";
import { agent, flow, gate, prompt, script } from "../../../fixtures/flow-builders.js";

const check = (nodes: unknown[], variables: BuildConfig["variables"] = []) => {
  const base = flow(nodes, []);
  return rule.check({ ...base, session: { ...base.session, buildConfig: { variables } } });
};

describe("undeclared-variable", () => {
  it.each([
    ["a prompt", prompt("fix", { settings: { instructions: "Fix {{x}}." } })],
    ["an agent", agent("fix", { settings: { instructions: "Fix {{x}}." } })],
  ])("reports %s using an undeclared variable, naming the node and the variable", (_, node) => {
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
          prompt("fix", { settings: { instructions: "Fix {{ticket}}." } }),
          agent("check", { settings: { instructions: "Run e2e: {{ e2e }}" } }),
        ],
        [
          { name: "ticket", kind: "text" },
          { name: "e2e", kind: "yesno" },
        ],
      ),
    ).toEqual([]);
  });

  it("does not scan nodes other than Prompt and Agent", () => {
    expect(
      check([
        script("run", { settings: { command: "echo {{x}}" } }),
        gate("look", { settings: { shown: "{{x}}", skippable: false } }),
      ]),
    ).toEqual([]);
  });
});
