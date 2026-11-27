import { describe, expect, it } from "vitest";
import { listPath } from "../../../src/core/run/list-path.js";

describe("listPath", () => {
  it("resolves the list file against the run folder", () => {
    expect(listPath("/repo", "docs/plan.md")).toBe("/repo/docs/plan.md");
  });
});
