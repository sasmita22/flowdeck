import { z } from "zod";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { FlowdeckBridge } from "../../preload/bridge.js";
import type { SaveState } from "../save-store.js";

export type AssistantBridge = Pick<
  FlowdeckBridge,
  "startBlueprintSession" | "stopBlueprintSession"
>;

export type AssistantState = {
  visible: boolean;
  flowId: string | null;
  session: string | null;
  show(): Promise<void>;
  hide(): void;
  end(): Promise<void>;
};

const startedSchema = z.object({ session: z.string() });

export const createAssistantStore = ({
  bridge,
  save,
}: {
  bridge: AssistantBridge;
  save: StoreApi<Pick<SaveState, "flowId" | "save">>;
}): StoreApi<AssistantState> =>
  createStore<AssistantState>()((set, get) => ({
    visible: false,
    flowId: null,
    session: null,

    show: async () => {
      if (get().session !== null) {
        set({ visible: true });
        return;
      }
      if (save.getState().flowId === null && !(await save.getState().save({ force: true }))) return;
      const flowId = save.getState().flowId;
      if (flowId === null) return;
      const { session } = startedSchema.parse(await bridge.startBlueprintSession({ flowId }));
      set({ visible: true, flowId, session });
    },

    hide: () => set({ visible: false }),

    end: async () => {
      const { flowId, session } = get();
      if (session === null || flowId === null) return;
      await bridge.stopBlueprintSession({ flowId });
      set({ visible: false, session: null });
    },
  }));
