export type NodeState = "waiting" | "sent" | "running" | "needs-you" | "failed" | "done";

const transitions: Record<NodeState, readonly NodeState[]> = {
  waiting: ["sent", "running"],
  sent: ["done", "failed"],
  running: ["done", "failed", "waiting"],
  "needs-you": [],
  failed: [],
  done: [],
};

export class IllegalMoveError extends Error {
  constructor(from: NodeState, to: NodeState) {
    super(`Illegal node state move from ${from} to ${to}`);
    this.name = "IllegalMoveError";
  }
}

export function move(from: NodeState, to: NodeState): NodeState {
  if (!transitions[from].includes(to)) throw new IllegalMoveError(from, to);
  return to;
}
