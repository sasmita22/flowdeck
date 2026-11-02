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

  describe("with its own exit codes", () => {
    const codes = { successCodes: [0, 3], retryCodes: [75] };

    it.each([0, 3])("is done for listed success code %i", (code) => {
      expect(scriptOutcome(code, 1, codes)).toBe("done");
    });

    it("retries a listed retry code once, then fails it", () => {
      expect(scriptOutcome(75, 1, codes)).toBe("retry");
      expect(scriptOutcome(75, 2, codes)).toBe("failed");
    });

    it.each([1, 2])("fails exit code %i that neither list names", (code) => {
      expect(scriptOutcome(code, 1, codes)).toBe("failed");
    });

    it("keeps 0 as done and 2 as retry when the lists are empty", () => {
      expect(scriptOutcome(0, 1, { successCodes: [], retryCodes: [] })).toBe("done");
      expect(scriptOutcome(2, 1, { successCodes: [], retryCodes: [] })).toBe("retry");
    });
  });
});
