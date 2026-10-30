import { describe, expect, it } from "vitest";
import { displayStatus } from "../../../src/core/run/display.js";
import type { NodeState } from "../../../src/core/run/state.js";

describe("displayStatus", () => {
  it.each<[NodeState, string]>([
    ["waiting", "waiting"],
    ["sent", "running"],
    ["running", "running"],
    ["needs-you", "needs you"],
    ["failed", "failed"],
    ["done", "done"],
    ["skipped", "done"],
  ])("shows %s as %s", (state, shown) => {
    expect(displayStatus(state)).toBe(shown);
  });
});
