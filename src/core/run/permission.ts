import type { WaitReply, WaitRequest } from "./wait.js";

type PermissionWait = Extract<WaitRequest, { kind: "permission" }>;

export type PermissionDecision = { behavior: "allow" } | { behavior: "deny"; message: string };

export type PermissionAsks = {
  onRequest(
    sessionId: string,
    handler: (payload: Record<string, unknown>, signal: AbortSignal) => Promise<PermissionDecision>,
  ): () => void;
};

const inputLimit = 200;
const fileTools = new Set(["Edit", "Write", "Read"]);

export const denied = (message: string): PermissionDecision => ({ behavior: "deny", message });

function inputOf(tool: string, toolInput: Record<string, unknown>): string {
  const field = tool === "Bash" ? "command" : fileTools.has(tool) ? "file_path" : undefined;
  const value = field === undefined ? undefined : toolInput[field];
  return typeof value === "string" ? value : JSON.stringify(toolInput).slice(0, inputLimit);
}

export function permissionRequest(
  nodeId: string,
  payload: Record<string, unknown>,
): PermissionWait {
  const toolName = payload["tool_name"];
  const toolInput = payload["tool_input"];
  const tool = typeof toolName === "string" ? toolName : "unknown";
  const input =
    typeof toolInput === "object" && toolInput !== null
      ? inputOf(tool, toolInput as Record<string, unknown>)
      : "";
  return { nodeId, kind: "permission", tool, input };
}

export function permissionDecision(reply: WaitReply): PermissionDecision {
  switch (reply.decision) {
    case "approve":
      return { behavior: "allow" };
    case "reject":
      return denied(reply.reason);
    case "closed":
      return denied("Flowdeck closed the request before an answer");
    default:
      return denied(`Flowdeck cannot allow a tool on a ${reply.decision} reply`);
  }
}
