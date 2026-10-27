export type TurnEndEvent = { sessionId: string; payload: Record<string, unknown> };

export type TurnEvents = {
  subscribe(kind: "Stop", sessionId: string, handler: (event: TurnEndEvent) => void): () => void;
};

export function waitForTurnEnd(
  events: TurnEvents,
  sessionId: string,
  timeoutMs: number,
): Promise<TurnEndEvent> {
  return new Promise((resolve, reject) => {
    const unsubscribe = events.subscribe("Stop", sessionId, (event) => {
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
