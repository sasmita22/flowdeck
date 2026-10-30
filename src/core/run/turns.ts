export type TurnEndEvent = { sessionId: string; payload: Record<string, unknown> };

export type TurnEvents = {
  subscribe(
    kind: "Stop" | "SubagentStop" | "PreToolUse",
    sessionId: string,
    handler: (event: TurnEndEvent) => void,
  ): () => void;
};

export const stampedBefore = (event: TurnEndEvent, armedAt: number | undefined) => {
  const hookAt = event.payload["flowdeck_hook_at"];
  return armedAt !== undefined && typeof hookAt === "number" && hookAt < armedAt;
};

export function waitForTurnEnd(
  events: TurnEvents,
  sessionId: string,
  timeoutMs: number,
  armedAt?: number,
): Promise<TurnEndEvent> {
  return new Promise((resolve, reject) => {
    const unsubscribe = events.subscribe("Stop", sessionId, (event) => {
      if (stampedBefore(event, armedAt)) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(event);
    });
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`no Stop for session ${sessionId} within ${timeoutMs} ms`));
    }, timeoutMs);
  });
}
