export type HookEventKind = "Stop" | "PreToolUse" | "PostToolUse" | "SubagentStop";

export type HookEvent = {
  kind: HookEventKind;
  sessionId: string;
  payload: Record<string, unknown>;
};

export interface EventSource {
  subscribe(
    kind: HookEventKind,
    sessionId: string,
    handler: (event: HookEvent) => void,
  ): () => void;
}
