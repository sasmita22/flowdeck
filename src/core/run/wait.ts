export type WaitRequest =
  | { nodeId: string; kind: "gate"; shown: string }
  | { nodeId: string; kind: "hardstop"; shown: string; condition: string }
  | { nodeId: string; kind: "ask"; question: string; options: string[] };

export type WaitReply =
  | { decision: "approve" }
  | { decision: "reject"; reason: string }
  | { decision: "continue" }
  | { decision: "stop"; reason: string }
  | { decision: "answer"; answer: string }
  | { decision: "closed" };

export type HumanWaiter = { wait(request: WaitRequest): Promise<WaitReply> };

export type HumanDecision =
  | { nodeId: string; decision: "approved" | "skipped" | "continued" }
  | { nodeId: string; decision: "rejected" | "stopped"; reason: string }
  | { nodeId: string; decision: "answered"; answer: string };

export type HumanOutcome =
  | { status: "done"; line: string; decision: HumanDecision }
  | { status: "failed"; reason: string; decision?: HumanDecision };
