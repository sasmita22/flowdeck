import { describe, expect, it } from "vitest";
import { rule } from "../../../../src/core/compiler/rules/hardstop-locked.js";
import { flow, hardstop } from "../../../fixtures/flow-builders.js";

const fieldsOf = (settings: Record<string, unknown>) =>
  rule
    .check(flow([hardstop("H", { settings })], []))
    .map(({ rule, node, field }) => ({ rule, node, field }));

describe("hardstop-locked", () => {
  it("reports a hard stop that is disabled", () => {
    expect(fieldsOf({ enabled: false })).toEqual([
      { rule: "hardstop-locked", node: "H", field: "enabled" },
    ]);
  });

  it("reports a hard stop that is unlocked", () => {
    expect(fieldsOf({ locked: false })).toEqual([
      { rule: "hardstop-locked", node: "H", field: "locked" },
    ]);
  });

  it("reports a disabled and unlocked hard stop twice", () => {
    expect(fieldsOf({ enabled: false, locked: false })).toEqual([
      { rule: "hardstop-locked", node: "H", field: "enabled" },
      { rule: "hardstop-locked", node: "H", field: "locked" },
    ]);
  });

  it("accepts an enabled, locked hard stop", () => {
    expect(fieldsOf({ enabled: true, locked: true })).toEqual([]);
  });
});
