import { nodeStatus } from "./run-events.js";
import type { NodeState } from "./state.js";
import type { EventEntry } from "./store.js";

type SessionState = "not-started" | "running" | "waiting" | "done" | "failed";

type SessionNodes = { nodeIds: readonly string[]; stopNode: string | undefined };

export function sessionState(session: SessionNodes, events: readonly EventEntry[]): SessionState {
  const statusOf = (nodeId: string): NodeState =>
    nodeStatus(events.filter((entry) => entry.nodeId === nodeId).map(({ event }) => event));
  const statuses = session.nodeIds.map(statusOf);
  if (statuses.includes("failed")) return "failed";
  if (session.stopNode !== undefined && statusOf(session.stopNode) === "done") return "done";
  if (statuses.includes("needs-you")) return "waiting";
  if (events.some(({ nodeId }) => session.nodeIds.includes(nodeId))) return "running";
  return "not-started";
}
