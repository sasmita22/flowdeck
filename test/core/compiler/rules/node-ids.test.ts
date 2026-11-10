import { describe, expect, it } from "vitest";
import { rule } from "../../../../src/core/compiler/rules/node-ids.js";
import { validate } from "../../../../src/core/compiler/validate.js";
import { agent, flow, onMainFlow, thenWire } from "../../../fixtures/flow-builders.js";

const errorsFor = (ids: string[]) =>
  rule
    .check(
      flow(
        ids.map((id) => agent(id)),
        [],
      ),
    )
    .map(({ rule, node, field }) => ({
      rule,
      node,
      field,
    }));

describe("node-ids", () => {
  it("accepts ids made of letters, digits, dashes and underscores", () => {
    expect(errorsFor(["work", "step_2", "A-1"])).toEqual([]);
  });

  it.each(["../x", "a/b", "a:b", "-lead", "a.b"])("reports the unsafe id %s", (id) => {
    expect(errorsFor(["work", id])).toEqual([{ rule: "node-ids", node: id, field: "id" }]);
  });

  it("reports a repeated id once, on its second use", () => {
    const errors = rule.check(flow([agent("work"), agent("work")], []));

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ rule: "node-ids", node: "work", field: "id" });
    expect(errors[0]?.message).toMatch(/more than once/);
  });

  it("reports a node whose id is both unsafe and repeated once", () => {
    const messages = rule.check(flow([agent("a/b"), agent("a/b")], [])).map((e) => e.message);

    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatch(/may only use/);
    expect(messages[1]).toMatch(/more than once/);
  });

  it("reports ids that differ only in case once, on the later one", () => {
    const errors = rule.check(flow([agent("work"), agent("Work")], []));

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ rule: "node-ids", node: "Work", field: "id" });
    expect(errors[0]?.message).toMatch(/more than once/);
  });

  it("makes validate reject a flow whose ids would collide on a case-insensitive disk", () => {
    const errors = validate(onMainFlow([agent("p1"), agent("P1")], [thenWire("p1", "P1")]));

    expect(errors.map(({ rule, node }) => ({ rule, node }))).toEqual([
      { rule: "node-ids", node: "P1" },
    ]);
  });
});
