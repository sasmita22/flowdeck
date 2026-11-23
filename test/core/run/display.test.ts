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

    it("shows a waiting node of a session that never started as not started", () => {
      expect(displayStatus("waiting", run, { started: false })).toBe("not-started");
    });

    it.each<NodeState>(["waiting", "failed", "done", "skipped"])(
      "shows %s in a started session as itself",
      (state) => {
        expect(displayStatus(state, run, { started: true })).toBe(state);
      },
    );

    it("shows a running node of a started session as stopped", () => {
      expect(displayStatus("running", run, { started: true })).toBe("stopped");
    });
  });

  it("shows a waiting node of a session not started yet as waiting while the run is running", () => {
    expect(displayStatus("waiting", "running", { started: false })).toBe("waiting");
  });
});
