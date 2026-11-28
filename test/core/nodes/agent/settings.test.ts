import { describe, expect, it } from "vitest";
import { defaultSettings } from "../../../../src/core/nodes/agent/defaults.js";
import { settings } from "../../../../src/core/nodes/agent/settings.js";

const base = { role: "", instructions: "", model: "sonnet" };

describe("Agent settings", () => {
  it("parses an agent saved before produce rows existed", () => {
    expect(settings.safeParse(base).success).toBe(true);
  });

  it("holds no produce rows", () => {
    expect(settings.safeParse({ ...base, produces: [] }).success).toBe(true);
  });

  it("holds several produce rows, complete or not", () => {
    const produces = [
      { variable: "a", yesIf: "x", noIf: "y" },
      { variable: "b", yesIf: "", noIf: "" },
    ];
    expect(settings.safeParse({ ...base, produces }).success).toBe(true);
  });

  it.each([{ given: [] }, { given: ["plan.md"] }, { writes: [] }, { writes: ["out.md"] }])(
    "rejects the removed field in %o",
    (removed) => {
      expect(settings.safeParse({ ...base, produces: [], ...removed }).success).toBe(false);
    },
  );

  it("rejects a produce row named after the Loop verdict", () => {
    const produces = [{ variable: "done", yesIf: "x", noIf: "y" }];
    expect(settings.safeParse({ ...base, produces }).success).toBe(false);
  });

  it("rejects the old single produced name", () => {
    expect(settings.safeParse({ ...base, produces: "approved" }).success).toBe(false);
  });

  it("rejects an unknown key on a produce row", () => {
    const produces = [{ variable: "a", yesIf: "x", noIf: "y", answer: true }];
    expect(settings.safeParse({ ...base, produces }).success).toBe(false);
  });

  it("defaults to no produce rows", () => {
    expect(defaultSettings.produces).toEqual([]);
    expect(settings.safeParse(defaultSettings).success).toBe(true);
  });
});
