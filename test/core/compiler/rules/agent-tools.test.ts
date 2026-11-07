import { describe, expect, it } from "vitest";
import { rule } from "../../../../src/core/compiler/rules/agent-tools.js";
import { agent, flow } from "../../../fixtures/flow-builders.js";

const check = (tools: string[], allowedTools: string[]) => {
  const base = flow([agent("reviewer", { settings: { tools } })], []);
  return rule.check({ ...base, session: { ...base.session, allowedTools } });
};

describe("agent-tools", () => {
  it("reports a tool the run session does not allow, naming the node and the tool", () => {
    const errors = check(["Read", "Bash"], ["Read", "Edit"]);

    expect(errors.map(({ rule, node, field }) => ({ rule, node, field }))).toEqual([
      { rule: "agent-tools", node: "reviewer", field: "tools" },
    ]);
    expect(errors[0]?.message).toContain("reviewer");
    expect(errors[0]?.message).toContain("Bash");
  });

  it("accepts an agent whose tools the session all allows", () => {
    expect(check(["Read", "Edit"], ["Edit", "Read", "Write"])).toEqual([]);
  });

  it("accepts an agent with no tools", () => {
    expect(check([], [])).toEqual([]);
  });
});
