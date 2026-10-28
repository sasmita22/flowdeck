import type { HumanDecision, WaitReply, WaitRequest } from "../../run/wait.js";
import { agentTurnText } from "../agent/execute.js";

export type LoopStep = { kind: "exit" } | { kind: "round"; round: number } | { kind: "cap" };

export type LoopAnswer =
  | { choice: "done" | "again" | "continue"; decision: HumanDecision }
  | { choice: "fail"; reason: string; decision?: HumanDecision };

export function verdictRequest(condition: string): string {
  return `End your reply with a fenced code block tagged json that holds {"done": true} if this condition holds, else {"done": false}. Condition: ${condition.replace(/[\r\n]+/g, " ")}`;
}

export function agentVerdictTurnText(hash: string, id: string, condition: string): string {
  return agentTurnText(hash, id).replace("Then reply DONE.", verdictRequest(condition));
}

export function nextStep(round: number, cap: number, done: boolean): LoopStep {
  if (done) return { kind: "exit" };
  return round < cap ? { kind: "round", round: round + 1 } : { kind: "cap" };
}

export function malformedRequest(loopId: string, round: number, reason: string): WaitRequest {
  return {
    nodeId: loopId,
    kind: "ask",
    question: `round ${round} gave no readable verdict (${reason}). Is the loop done?`,
    options: ["done", "again", "fail"],
  };
}

export function capRequest(loopId: string, cap: number): WaitRequest {
  return {
    nodeId: loopId,
    kind: "ask",
    question: `cap reached after ${cap} rounds. Continue after the loop, or fail?`,
    options: ["continue", "fail"],
  };
}

function loopAnswer(
  loopId: string,
  reply: WaitReply,
  choices: readonly ("done" | "again" | "continue")[],
  failReason: string,
): LoopAnswer {
  if (reply.decision === "closed") return { choice: "fail", reason: "no answer: input closed" };
  if (reply.decision !== "answer") {
    return { choice: "fail", reason: `unexpected reply: ${reply.decision}` };
  }
  const decision: HumanDecision = { nodeId: loopId, decision: "answered", answer: reply.answer };
  if (reply.answer === "fail") return { choice: "fail", reason: failReason, decision };
  const choice = choices.find((option) => option === reply.answer);
  if (choice === undefined) return { choice: "fail", reason: `unexpected answer: ${reply.answer}` };
  return { choice, decision };
}

export function malformedAnswer(loopId: string, round: number, reply: WaitReply): LoopAnswer {
  return loopAnswer(loopId, reply, ["done", "again"], `no verdict in round ${round}`);
}

export function capAnswer(loopId: string, cap: number, reply: WaitReply): LoopAnswer {
  return loopAnswer(loopId, reply, ["continue"], `cap reached after ${cap} rounds`);
}
