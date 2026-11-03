import { withItem } from "../foreach/execute.js";

export type AgentOutcome = "done" | "failed";

export function agentType(prefix: string, nodeId: string): string {
  return `${prefix}:${nodeId}`;
}

export function agentNodeId(type: string): string | undefined {
  const separator = type.indexOf(":");
  return separator === -1 ? undefined : type.slice(separator + 1);
}

export function agentTurnText(prefix: string, nodeId: string, item?: string): string {
  const prompt = item === undefined ? "Go" : withItem("Go.", item);
  return `Use the Agent tool with subagent_type "${agentType(prefix, nodeId)}" and the prompt ${JSON.stringify(prompt)}. Then reply DONE.`;
}

export function agentOutcome(
  seenAgentTypes: readonly string[],
  prefix: string,
  nodeId: string,
): AgentOutcome {
  return seenAgentTypes.includes(agentType(prefix, nodeId)) ? "done" : "failed";
}
