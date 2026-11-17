import { describe, expect, it } from "vitest";
import { displayStatus } from "../../../src/core/run/display.js";
import type { SnapshotStatus } from "../../../src/core/run/snapshot.js";
import type { NodeState } from "../../../src/core/run/state.js";

describe("displayStatus", () => {
  describe.each<SnapshotStatus>(["running", "stopped"])("in a %s run", (run) => {
    it.each<[NodeState, string]>([
      ["waiting", "waiting"],
      ["sent", "sent"],
      ["running", "running"],
      ["failed", "failed"],
      ["done", "done"],
      ["skipped", "skipped"],
    ])("shows %s as %s", (state, shown) => {
      expect(displayStatus(state, run)).toBe(shown);
    });
  });

  it("shows needs-you as needs you while the run is running", () => {
    expect(displayStatus("needs-you", "running")).toBe("needs you");
  });

  it.each<SnapshotStatus>(["stopped", "done", "failed", "interrupted"])(
    "shows needs-you as stopped once the run is %s",
    (run) => {
      expect(displayStatus("needs-you", run)).toBe("stopped");
    },
  );
});
