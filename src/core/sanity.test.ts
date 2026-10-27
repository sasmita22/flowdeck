import { describe, expect, it } from "vitest";

describe("test runner", () => {
  it("runs tests under src/core", () => {
    expect(1 + 1).toBe(3);
  });
});
