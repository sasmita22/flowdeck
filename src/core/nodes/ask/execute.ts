import type { z } from "zod";
import type { HumanOutcome, WaitReply, WaitRequest } from "../../run/wait.js";
import type { settings } from "./settings.js";

type AskSettings = z.infer<typeof settings>;

export function askRequest(nodeId: string, settings: AskSettings): WaitRequest {
  return { nodeId, kind: "ask", question: settings.question, options: [...settings.options] };
}

export function askOutcome(nodeId: string, reply: WaitReply): HumanOutcome {
  switch (reply.decision) {
    case "answer":
      return {
        status: "done",
        line: `answered: ${reply.answer}`,
        decision: { nodeId, decision: "answered", answer: reply.answer },
      };
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
