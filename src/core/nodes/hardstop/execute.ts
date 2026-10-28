import type { z } from "zod";
import type { HumanOutcome, WaitReply, WaitRequest } from "../../run/wait.js";
import type { settings } from "./settings.js";

type HardstopSettings = z.infer<typeof settings>;

export function hardstopRequest(nodeId: string, settings: HardstopSettings): WaitRequest {
  return { nodeId, kind: "hardstop", shown: settings.shown, condition: settings.condition };
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
    case "closed":
      return { status: "failed", reason: "no answer: input closed" };
    default:
      return { status: "failed", reason: `unexpected reply: ${reply.decision}` };
  }
}
