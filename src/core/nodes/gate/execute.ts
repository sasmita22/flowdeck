import type { z } from "zod";
import type { HumanOutcome, WaitReply, WaitRequest } from "../../run/wait.js";
import type { settings } from "./settings.js";

type GateSettings = z.infer<typeof settings>;

export function gateSkips(settings: GateSettings, auto: boolean): boolean {
  return auto && settings.skippable;
}

export function gateRequest(nodeId: string, settings: GateSettings): WaitRequest {
  return { nodeId, kind: "gate", shown: settings.shown };
}

export function gateOutcome(nodeId: string, reply: WaitReply): HumanOutcome {
  switch (reply.decision) {
    case "approve":
      return { status: "done", line: "approved", decision: { nodeId, decision: "approved" } };
    case "reject":
      return {
        status: "failed",
        reason: reply.reason === "" ? "rejected" : `rejected: ${reply.reason}`,
        decision: { nodeId, decision: "rejected", reason: reply.reason },
      };
    case "closed":
      return { status: "failed", reason: "no answer: input closed" };
    default:
      return { status: "failed", reason: `unexpected reply: ${reply.decision}` };
  }
}
