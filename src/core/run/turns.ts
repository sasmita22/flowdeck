export type TurnEndEvent = { sessionId: string; payload: Record<string, unknown> };

export type TurnEvents = {
  subscribe(
    kind: "Stop" | "StopFailure" | "SubagentStop" | "PreToolUse" | "PostToolUse",
    sessionId: string,
    handler: (event: TurnEndEvent) => void,
  ): () => void;
};

export const stampedBefore = (event: TurnEndEvent, armedAt: number | undefined) => {
  const hookAt = event.payload["flowdeck_hook_at"];
  return armedAt !== undefined && typeof hookAt === "number" && hookAt < armedAt;
};

export function turnFailure(event: TurnEndEvent): Error {
  const { last_assistant_message: message, error } = event.payload;
  if (typeof message === "string" && message !== "") return new Error(message);
  if (typeof error === "string" && error !== "") return new Error(error);
  return new Error(`turn failed for session ${event.sessionId}`);
}

export function waitForTurnEnd(
  events: TurnEvents,
  sessionId: string,
  timeoutMs: number,
  armedAt?: number,
  held?: () => boolean,
): Promise<TurnEndEvent> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      clearTimeout(timer);
      unsubscribeStop();
      unsubscribeFailure();
    };
    const unsubscribeStop = events.subscribe("Stop", sessionId, (event) => {
      if (stampedBefore(event, armedAt)) return;
      finish();
      resolve(event);
    });
    const unsubscribeFailure = events.subscribe("StopFailure", sessionId, (event) => {
      if (stampedBefore(event, armedAt)) return;
      finish();
      reject(turnFailure(event));
    });
    const arm = () => {
      timer = setTimeout(() => {
        if (held?.() === true) return arm();
        finish();
        reject(new Error(`no Stop for session ${sessionId} within ${timeoutMs} ms`));
      }, timeoutMs);
    };
    arm();
  });
}
