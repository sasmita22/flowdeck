import type { z } from "zod";
import type { HumanOutcome, WaitReply, WaitRequest } from "../../run/wait.js";
import { verdictRequest } from "../loop/execute.js";
import type { settings } from "./settings.js";

type GateSettings = z.infer<typeof settings>;

export function gateSkips(settings: GateSettings, auto: boolean): boolean {
  return auto && settings.stopWhen === "always";
}

export function gateRequest(nodeId: string, settings: GateSettings): WaitRequest {
  return settings.stopWhen === "conditional"
    ? { nodeId, kind: "gate", instruction: settings.instruction, condition: settings.condition }
    : { nodeId, kind: "gate", instruction: settings.instruction };
}

export function gateCheckTurn(condition: string): string {
  return `Before going on, check this condition against the work so far. ${verdictRequest(condition)}`;
}

export function noVerdictRequest(nodeId: string, reason: string): WaitRequest {
  return {
    nodeId,
    kind: "ask",
    question: `The gate's check got no readable verdict (${reason}). Stop the run here?`,
    options: ["stop", "continue"],
  };
}

const continued = (nodeId: string, text: string | undefined): HumanOutcome => ({
  status: "done",
  line: "continued",
  decision:
    text === undefined || text.trim() === ""
      ? { nodeId, decision: "continued" }
      : { nodeId, decision: "continued", text },
});

export function gateCheckOutcome(nodeId: string, reply: WaitReply): HumanOutcome {
  switch (reply.decision) {
    case "continue":
      return continued(nodeId, reply.text);
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

export function answerContext(answers: readonly string[]): string {
  return answers.length === 0
    ? ""
    : `${answers.map((answer) => `The user answered: ${answer}`).join(". ")}.`;
}
