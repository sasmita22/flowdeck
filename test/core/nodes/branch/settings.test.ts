import { describe, expect, it } from "vitest";
import { defaultSettings } from "../../../../src/core/nodes/branch/defaults.js";
import { settings } from "../../../../src/core/nodes/branch/settings.js";

describe("Branch settings", () => {
  it("holds a variable name", () => {
    expect(settings.safeParse({ variable: "approved" }).success).toBe(true);
  });

  it("holds the shared flag set by picking an existing variable", () => {
    expect(settings.safeParse({ variable: "approved", shared: true }).success).toBe(true);
  });

  it.each([
    { decidedBy: "variable" },
    { decidedBy: "value" },
    { value: "" },
    { value: "approved" },
  ])("rejects the removed field in %o", (removed) => {
    expect(settings.safeParse({ variable: "approved", ...removed }).success).toBe(false);
  });

  it("defaults parse and carry neither decidedBy nor value", () => {
    expect(settings.safeParse(defaultSettings).success).toBe(true);
    expect(defaultSettings).not.toHaveProperty("decidedBy");
    expect(defaultSettings).not.toHaveProperty("value");
  });
});
