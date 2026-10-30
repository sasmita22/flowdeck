import { pendingWaitSchema, waitAnswerSchema, type PendingWait } from "../../core/run/wait.js";
import type { EnginePush } from "../engine/protocol.js";
import type { EngineClient } from "./engine-client.js";

export type WaitRelay = {
  onPush(push: EnginePush): void;
  latest(): PendingWait | null;
};

export function createWaitRelay(options: { send: (value: PendingWait | null) => void }): WaitRelay {
  let latest: PendingWait | null = null;
  return {
    onPush(push) {
      if (push.push !== "wait") return;
      if (push.value === null) {
        latest = null;
      } else {
        const parsed = pendingWaitSchema.safeParse(push.value);
        if (!parsed.success) return;
        latest = parsed.data;
      }
      options.send(latest);
    },
    latest: () => latest,
  };
}

export async function answerWait(
  client: Pick<EngineClient, "request">,
  payload: unknown,
): Promise<boolean> {
  const parsed = waitAnswerSchema.safeParse(payload);
  if (!parsed.success) return false;
  const { accepted } = (await client.request("answer-wait", parsed.data)) as { accepted: boolean };
  return accepted;
}
