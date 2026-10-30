import type { NodeState } from "./state.js";

export type DisplayStatus = "waiting" | "running" | "needs you" | "failed" | "done";

export function displayStatus(state: NodeState): DisplayStatus {
  switch (state) {
    case "waiting":
      return "waiting";
    case "sent":
    case "running":
      return "running";
    case "needs-you":
      return "needs you";
    case "failed":
      return "failed";
    case "done":
    case "skipped":
      return "done";
  }
}
