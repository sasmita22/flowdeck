import { move, type NodeState } from "./state.js";
import type { HumanDecision } from "./wait.js";

export type RunEvent =
  | { kind: "sent" | "running" | "retry" | "needs-you" | "skipped" | "reset" }
  | { kind: "done"; payload?: { stopMessage?: string } }
  | { kind: "failed"; payload: { message: string } }
  | { kind: "decided" | "answered"; payload: HumanDecision }
  | { kind: "round"; payload: { round: number } }
  | {
      kind: "budget";
      payload:
        | { step: "paused"; spend: number; budget: number; unconfirmed?: true }
        | { step: "raised"; budget: number }
        | { step: "stopped"; reason: string };
    };

const moves: Partial<Record<RunEvent["kind"], NodeState>> = {
  sent: "sent",
  running: "running",
  retry: "waiting",
  "needs-you": "needs-you",
  done: "done",
  failed: "failed",
  skipped: "skipped",
  reset: "waiting",
};

export function nodeStatus(events: readonly RunEvent[]): NodeState {
  return events.reduce<NodeState>((status, event) => {
    const to = moves[event.kind];
    return to === undefined ? status : move(status, to);
  }, "waiting");
}

export function loopRound(events: readonly RunEvent[]): number {
  const last = events.findLast((event) => event.kind === "round");
  return last?.kind === "round" ? last.payload.round : 0;
}

export function decisionsOf(events: readonly RunEvent[]): HumanDecision[] {
  return events.flatMap((event) =>
    event.kind === "decided" || event.kind === "answered" ? [event.payload] : [],
  );
}
