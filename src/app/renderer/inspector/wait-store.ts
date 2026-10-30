import { createStore, type StoreApi } from "zustand/vanilla";
import { pendingWaitSchema, type PendingWait, type WaitAnswer } from "../../../core/run/wait.js";
import type { FlowdeckBridge } from "../../preload/bridge.js";

export type WaitBridge = Pick<FlowdeckBridge, "getWait" | "onWait" | "answerWait">;

export type WaitState = {
  pending: PendingWait | null;
  error: string | null;
  connect(): Promise<void>;
  answer(reply: WaitAnswer["reply"]): Promise<void>;
};

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

const toPending = (value: unknown): PendingWait | null | undefined => {
  if (value === null) return null;
  const parsed = pendingWaitSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
};

export const createWaitStore = ({ bridge }: { bridge: WaitBridge }): StoreApi<WaitState> =>
  createStore<WaitState>()((set, get) => ({
    pending: null,
    error: null,

    connect: async () => {
      let pushed = false;
      bridge.onWait((value) => {
        const pending = toPending(value);
        if (pending === undefined) return;
        pushed = true;
        set({ pending });
      });
      const fetched = toPending(await bridge.getWait());
      if (!pushed && fetched !== undefined) set({ pending: fetched });
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
  }));
