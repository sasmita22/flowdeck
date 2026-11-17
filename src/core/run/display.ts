import type { SnapshotStatus } from "./snapshot.js";
import type { NodeState } from "./state.js";

export type DisplayStatus =
  "waiting" | "sent" | "running" | "needs you" | "stopped" | "failed" | "done" | "skipped";

export function displayStatus(state: NodeState, run: SnapshotStatus): DisplayStatus {
  switch (state) {
    case "waiting":
      return "waiting";
    case "sent":
      return "sent";
    case "running":
      return "running";
    case "needs-you":
      return run === "running" ? "needs you" : "stopped";
    case "failed":
      return "failed";
    case "done":
      return "done";
    case "skipped":
      return "skipped";
  }
}
