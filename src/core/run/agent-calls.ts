export type AgentCall = {
  toolUseId?: string;
  nodeId?: string;
  piece?: string;
  agentType?: string;
  agentId?: string;
  status?: string;
  background?: true;
};

export type AgentCallEvent = {
  kind: "PreToolUse" | "PostToolUse" | "SubagentStop" | "Stop" | "StopFailure";
  payload: Record<string, unknown>;
};

export type Marker = { nodeId: string } | { piece: string } | Record<string, never>;

const nodeLead = "NODE ";
const pieceLead = "PIECE ";

export function nodeMarker(nodeId: string): string {
  return `${nodeLead}${nodeId}`;
}

export function pieceMarker(path: string): string {
  return `${pieceLead}${path}`;
}

export function markerOf(prompt: string): Marker {
  const [first = ""] = prompt.split("\n", 1);
  const line = first.trim();
  if (line.startsWith(nodeLead)) return { nodeId: line.slice(nodeLead.length).trim() };
  if (line.startsWith(pieceLead)) return { piece: line.slice(pieceLead.length).trim() };
  return {};
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

const defined = (fields: Record<string, string | undefined>) =>
  Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));

export function agentCallOf({ kind, payload }: AgentCallEvent): AgentCall | undefined {
  if (kind === "SubagentStop") {
    const agentId = text(payload["agent_id"]);
    return text(payload["agent_type"]) === undefined && agentId !== undefined
      ? { background: true, agentId }
      : undefined;
  }
  if (kind !== "PreToolUse" && kind !== "PostToolUse") return undefined;
  if (payload["tool_name"] !== "Agent") return undefined;
  const input = record(payload["tool_input"]);
  const prompt = text(input["prompt"]) ?? "";
  const response = kind === "PostToolUse" ? record(payload["tool_response"]) : {};
  return {
    ...defined({ toolUseId: text(payload["tool_use_id"]) }),
    ...markerOf(prompt),
    ...defined({
      agentType: text(response["agentType"]) ?? text(input["subagent_type"]),
      agentId: text(response["agentId"]),
      status: text(response["status"]),
    }),
  };
}
