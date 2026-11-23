import type { SnapshotStatus } from "./snapshot.js";
import type { NodeState } from "./state.js";

export type DisplayStatus =
  | "waiting"
  | "not-started"
  | "sent"
  | "running"
  | "needs you"
  | "stopped"
  | "failed"
  | "done"
  | "skipped";

export function displayStatus(
  state: NodeState,
  run: SnapshotStatus,
  { started }: { started: boolean } = { started: true },
): DisplayStatus {
  switch (state) {
    case "waiting":
      return started || run === "running" ? "waiting" : "not-started";
    case "sent":
    case "running":
      return run === "running" ? state : "stopped";
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
