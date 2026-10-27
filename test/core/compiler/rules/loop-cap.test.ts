import { describe, expect, it } from "vitest";
import { rule } from "../../../../src/core/compiler/rules/loop-cap.js";
import { flow, loop, prompt } from "../../../fixtures/flow-builders.js";

const fieldsOf = (settings: Record<string, unknown>) =>
  rule
    .check(flow([loop("L", { settings })], []))
    .map(({ rule, node, field }) => ({ rule, node, field }));

describe("loop-cap", () => {
  it("reports a loop with no cap", () => {
    expect(fieldsOf({ cap: undefined })).toEqual([{ rule: "loop-cap", node: "L", field: "cap" }]);
  });

  it.each([2.5, 0])("reports a loop whose cap is %s", (cap) => {
    expect(fieldsOf({ cap })).toEqual([{ rule: "loop-cap", node: "L", field: "cap" }]);
  });

  it("reports a loop with no onCap", () => {
    expect(fieldsOf({ onCap: undefined })).toEqual([
      { rule: "loop-cap", node: "L", field: "onCap" },
    ]);
  });

  it("reports a missing cap and a missing onCap separately", () => {
    expect(fieldsOf({ cap: undefined, onCap: undefined })).toEqual([
      { rule: "loop-cap", node: "L", field: "cap" },
      { rule: "loop-cap", node: "L", field: "onCap" },
    ]);
  });

  it("accepts a loop with cap 1 and an onCap", () => {
    expect(fieldsOf({ cap: 1, onCap: "ask" })).toEqual([]);
  });

  it("accepts a flow with no loop", () => {
    expect(rule.check(flow([prompt("P")], []))).toEqual([]);
  });
});
