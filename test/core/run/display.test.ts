import { describe, expect, it } from "vitest";
import { displayStatus } from "../../../src/core/run/display.js";
import type { SnapshotStatus } from "../../../src/core/run/snapshot.js";
import type { NodeState } from "../../../src/core/run/state.js";

describe("displayStatus", () => {
  const ended: SnapshotStatus[] = ["stopped", "done", "failed", "interrupted"];

  it.each<[NodeState, string]>([
    ["waiting", "waiting"],
    ["sent", "sent"],
    ["running", "running"],
    ["needs-you", "needs you"],
    ["failed", "failed"],
    ["done", "done"],
    ["skipped", "skipped"],
  ])("shows %s as %s while the run is running", (state, shown) => {
    expect(displayStatus(state, "running")).toBe(shown);
  });

  describe.each(ended)("once the run is %s", (run) => {
    it.each<NodeState>(["sent", "running", "needs-you"])("shows %s as stopped", (state) => {
      expect(displayStatus(state, run)).toBe("stopped");
    });

    it.each<NodeState>(["waiting", "failed", "done", "skipped"])("shows %s as itself", (state) => {
      expect(displayStatus(state, run)).toBe(state);
    });
  });
});
