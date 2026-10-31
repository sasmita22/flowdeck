export type AgentOutcome = "done" | "failed";

export function agentType(hash: string, nodeId: string): string {
  return `${hash}:${nodeId}`;
}

export function agentNodeId(type: string): string | undefined {
  const separator = type.indexOf(":");
  return separator === -1 ? undefined : type.slice(separator + 1);
}

export function agentTurnText(hash: string, nodeId: string): string {
  return `Use the Agent tool with subagent_type "${agentType(hash, nodeId)}" and the prompt "Go". Then reply DONE.`;
}

export function agentOutcome(
  seenAgentTypes: readonly string[],
  hash: string,
  nodeId: string,
): AgentOutcome {
  return seenAgentTypes.includes(agentType(hash, nodeId)) ? "done" : "failed";
}
