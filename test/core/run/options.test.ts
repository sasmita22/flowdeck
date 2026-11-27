import { describe, expect, it } from "vitest";
import { runChoicesSchema, storedAuto, storedOptions } from "../../../src/core/run/options.js";

describe("runChoicesSchema", () => {
  it("accepts choices that carry nothing but their kind", () => {
    expect(runChoicesSchema.parse({ kind: "choices" })).toEqual({ kind: "choices" });
  });

  it("accepts an error with its message", () => {
    expect(runChoicesSchema.parse({ kind: "error", message: "x" })).toEqual({
      kind: "error",
      message: "x",
    });
  });
});

describe("stored run options", () => {
  it("keeps automatic mode in the stored record", () => {
    expect(storedOptions({ auto: true })).toEqual({ auto: true });
    expect(storedOptions({ auto: false })).toEqual({});
  });

  it("reads back automatic mode for a resume", () => {
    expect(storedAuto({ ticket: "FD-1", deep: false, auto: true })).toBe(true);
    expect(storedAuto({ auto: "yes" })).toBe(false);
  });
});
