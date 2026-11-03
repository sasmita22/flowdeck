import { describe, expect, it } from "vitest";
import {
  fillVariables,
  isVariableName,
  referencedVariables,
  unsetVariables,
} from "../../../src/core/flow/variables.js";
import type { BuildConfig } from "../../../src/core/flow/schema.js";

describe("referencedVariables", () => {
  it("returns each distinct name once, in the order first used", () => {
    expect(referencedVariables("Fix {{ticket}} and {{ticket}} {{ x }}")).toEqual(["ticket", "x"]);
  });

  it("returns nothing for text without a variable", () => {
    expect(referencedVariables("Implement the plan.")).toEqual([]);
  });
});

describe("fillVariables", () => {
  it("puts a text value in place of its name", () => {
    expect(fillVariables("Fix {{ticket}}", { ticket: "FD-99" })).toBe("Fix FD-99");
  });

  it("fills a name written with spaces inside the braces", () => {
    expect(fillVariables("Fix {{ ticket }}", { ticket: "FD-99" })).toBe("Fix FD-99");
  });

  it.each([
    [true, "Run e2e: true"],
    [false, "Run e2e: false"],
  ])("fills the yes/no value %j as %j", (value, filled) => {
    expect(fillVariables("Run e2e: {{e2e}}", { e2e: value })).toBe(filled);
  });
});

describe("unsetVariables", () => {
  const config = (variables: BuildConfig["variables"]): BuildConfig => ({ variables });

  it("lists a text variable with no value and an empty text value", () => {
    expect(
      unsetVariables(
        config([
          { name: "ticket", kind: "text" },
          { name: "title", kind: "text" },
          { name: "owner", kind: "text" },
        ]),
        { title: "", owner: "me" },
      ),
    ).toEqual(["ticket", "title"]);
  });

  it("lists a yes/no variable with no default and no value", () => {
    expect(unsetVariables(config([{ name: "e2e", kind: "yesno" }]), {})).toEqual(["e2e"]);
  });

  it("counts a yes/no false as set", () => {
    expect(unsetVariables(config([{ name: "e2e", kind: "yesno" }]), { e2e: false })).toEqual([]);
  });

  it("counts a default as set", () => {
    expect(
      unsetVariables(
        config([
          { name: "e2e", kind: "yesno", default: false },
          { name: "ticket", kind: "text", default: "FD-1" },
        ]),
        {},
      ),
    ).toEqual([]);
  });
});

describe("isVariableName", () => {
  it.each(["proceed-e2e", "ticket", "step_2", "A1"])("accepts %j", (name) => {
    expect(isVariableName(name)).toBe(true);
  });

  it.each(["-x", "a b", "", "_x", "a.b", "{{x}}"])("rejects %j", (name) => {
    expect(isVariableName(name)).toBe(false);
  });
});
