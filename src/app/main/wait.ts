import { pendingWaitSchema, waitAnswerSchema, type PendingWait } from "../../core/run/wait.js";
import type { EnginePush } from "../engine/protocol.js";
import type { EngineClient } from "./engine-client.js";

export type RunWait = { runId: string; value: PendingWait | null };

export type WaitRelay = {
  onPush(push: EnginePush): void;
  latest(runId: string): PendingWait | null;
};

export function createWaitRelay(options: { send: (update: RunWait) => void }): WaitRelay {
  const latest = new Map<string, PendingWait>();
  return {
    onPush(push) {
      if (push.push !== "wait") return;
      const { runId } = push;
      if (push.value === null) {
        latest.delete(runId);
        options.send({ runId, value: null });
        return;
      }
      const parsed = pendingWaitSchema.safeParse(push.value);
      if (!parsed.success) return;
      latest.set(runId, parsed.data);
      options.send({ runId, value: parsed.data });
    },
    latest: (runId) => latest.get(runId) ?? null,
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
