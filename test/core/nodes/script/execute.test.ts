import { describe, expect, it } from "vitest";
import { scriptOutcome } from "../../../../src/core/nodes/script/execute.js";

describe("scriptOutcome", () => {
  it.each([1, 2])("is done for exit code 0 on attempt %i", (attempt) => {
    expect(scriptOutcome(0, attempt)).toBe("done");
  });

  it("retries exit code 2 on the first attempt", () => {
    expect(scriptOutcome(2, 1)).toBe("retry");
  });

  it("fails exit code 2 on the second attempt", () => {
    expect(scriptOutcome(2, 2)).toBe("failed");
  });

  it.each([1, 3, 127])("fails exit code %i", (code) => {
    expect(scriptOutcome(code, 1)).toBe("failed");
  });

  it("fails a script killed by a signal", () => {
    expect(scriptOutcome(null, 1)).toBe("failed");
  });
});
