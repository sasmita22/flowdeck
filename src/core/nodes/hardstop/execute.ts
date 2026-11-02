import type { z } from "zod";
import type { HumanOutcome, WaitReply, WaitRequest } from "../../run/wait.js";
import { verdictRequest } from "../loop/execute.js";
import type { settings } from "./settings.js";

type HardstopSettings = z.infer<typeof settings>;

export function hardstopRequest(nodeId: string, settings: HardstopSettings): WaitRequest {
  return { nodeId, kind: "hardstop", shown: settings.shown, condition: settings.condition };
}

export function hardstopCheckTurn(condition: string): string {
  return `Before going on, check this hard stop condition against the work so far. ${verdictRequest(condition)}`;
}

export function noVerdictRequest(nodeId: string, reason: string): WaitRequest {
  return {
    nodeId,
    kind: "ask",
    question: `The hard stop got no readable verdict (${reason}). Stop the run here?`,
    options: ["stop", "continue"],
  };
}

export function hardstopOutcome(nodeId: string, reply: WaitReply): HumanOutcome {
  switch (reply.decision) {
    case "continue":
      return { status: "done", line: "continued", decision: { nodeId, decision: "continued" } };
    case "stop":
      return {
        status: "failed",
        reason: reply.reason === "" ? "stopped" : `stopped: ${reply.reason}`,
        decision: { nodeId, decision: "stopped", reason: reply.reason },
      };
    case "answer": {
      const decision = { nodeId, decision: "answered" as const, answer: reply.answer };
      if (reply.answer === "continue") {
        return { status: "done", line: "answered: continue", decision };
      }
      if (reply.answer === "stop") {
        return { status: "failed", reason: "stopped: no readable verdict", decision };
      }
      return { status: "failed", reason: `unexpected answer: ${reply.answer}` };
    }
    case "closed":
      return { status: "failed", reason: "no answer: input closed" };
    default:
      return { status: "failed", reason: `unexpected reply: ${reply.decision}` };
  }
}
