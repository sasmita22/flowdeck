import { createStore, type StoreApi } from "zustand/vanilla";
import { pendingWaitSchema, type PendingWait, type WaitAnswer } from "../../../core/run/wait.js";
import type { FlowdeckBridge } from "../../preload/bridge.js";
import { pushFor } from "../run-push.js";

export type WaitBridge = Pick<FlowdeckBridge, "getWait" | "onWait" | "answerWait">;

export type WaitState = {
  runId: string | null;
  pending: PendingWait | null;
  error: string | null;
  connect(): Promise<void>;
  view(runId: string): Promise<void>;
  answer(reply: WaitAnswer["reply"]): Promise<void>;
};

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

const toPending = (value: unknown): PendingWait | null | undefined => {
  if (value === null) return null;
  const parsed = pendingWaitSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
};

export const createWaitStore = ({ bridge }: { bridge: WaitBridge }): StoreApi<WaitState> =>
  createStore<WaitState>()((set, get) => {
    let pushed = false;

    return {
      runId: null,
      pending: null,
      error: null,

      connect: async () => {
        bridge.onWait((value) => {
          const push = pushFor(value, get().runId);
          if (push === null) return;
          const pending = toPending(push["value"]);
          if (pending === undefined) return;
          pushed = true;
          set({ pending });
        });
      },

      view: async (runId) => {
        pushed = false;
        set({ runId, pending: null });
        const fetched = toPending(await bridge.getWait(runId));
        if (!pushed && get().runId === runId && fetched !== undefined) set({ pending: fetched });
      },

      answer: async (reply) => {
        const { pending } = get();
        if (pending === null) return;
        let error: string | null = null;
        try {
          await bridge.answerWait({ waitId: pending.waitId, reply });
        } catch (thrown) {
          error = messageOf(thrown);
        }
        set({ error });
      },
    };
  });
