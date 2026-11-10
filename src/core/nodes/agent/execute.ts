import { handoffText, type Handoff } from "../../flow/handoff.js";
import { nodeMarker, type AgentCall } from "../../run/agent-calls.js";
import { answerContext } from "../ask/execute.js";
import { withItem } from "../foreach/execute.js";

export type AgentOutcome = "done" | "failed";

export type AgentTurnNode = { id: string } & Handoff;

export function agentType(prefix: string, piece: string): string {
  return `${prefix}:${piece}`;
}

export function agentPrompt(
  node: AgentTurnNode,
  item?: string,
  answers: readonly string[] = [],
): string {
  const go = item === undefined ? "Go" : withItem("Go.", item);
  return [nodeMarker(node.id), handoffText(node).trim(), answerContext(answers), go]
    .filter((line) => line !== "")
    .join("\n");
}

export function agentTurnText(
  prefix: string,
  piece: string,
  node: AgentTurnNode,
  item?: string,
  answers: readonly string[] = [],
): string {
  return `Use the Agent tool with subagent_type "${agentType(prefix, piece)}" and the prompt ${JSON.stringify(agentPrompt(node, item, answers))}. Then reply DONE.`;
}

export function agentOutcome(calls: readonly AgentCall[], nodeId: string): AgentOutcome {
  return calls.some((call) => call.nodeId === nodeId && call.status !== undefined)
    ? "done"
    : "failed";
}
