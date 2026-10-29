import { createStore, type StoreApi } from "zustand/vanilla";
import { saveFlowResultSchema } from "../../core/flow/flow-store.js";
import type { FlowdeckBridge } from "../preload/bridge.js";
import { newCanvasFlow, selectDirty, type CanvasState } from "./canvas/store.js";

export type SaveBridge = Pick<
  FlowdeckBridge,
  "saveFlow" | "loadLatestFlow" | "setDirty" | "onCloseRequest" | "answerClose"
>;

export type CloseChoice = "save" | "discard" | "cancel";

export type SaveState = {
  saving: boolean;
  error: string | null;
  closePrompt: boolean;
  open(): Promise<void>;
  save(): Promise<boolean>;
  answerClose(answer: CloseChoice): Promise<void>;
};

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export const createSaveStore = ({
  bridge,
  canvas,
}: {
  bridge: SaveBridge;
  canvas: StoreApi<CanvasState>;
}): StoreApi<SaveState> => {
  const store = createStore<SaveState>()((set, get) => {
    const fail = (message: string) => {
      set({ saving: false, error: message });
      return false;
    };

    const save = async () => {
      if (get().saving) return false;
      if (!selectDirty(canvas.getState())) return true;
      const sent = canvas.getState().flow;
      set({ saving: true, error: null });
      let reply: unknown;
      try {
        reply = await bridge.saveFlow(sent);
      } catch (error) {
        return fail(messageOf(error));
      }
      const result = saveFlowResultSchema.safeParse(reply);
      if (!result.success) return fail("unexpected save result");
      if (result.data.kind === "error") return fail(result.data.message);
      canvas.getState().markSaved(sent);
      set({ saving: false });
      return true;
    };

    return {
      saving: false,
      error: null,
      closePrompt: false,

      open: async () => {
        try {
          const latest = await bridge.loadLatestFlow();
          canvas.getState().load(latest ?? newCanvasFlow());
        } catch (error) {
          set({ error: messageOf(error) });
        }
      },

      save,

      answerClose: async (answer) => {
        if (answer === "cancel") {
          set({ closePrompt: false });
          bridge.answerClose("cancel");
          return;
        }
        if (answer === "discard") {
          set({ closePrompt: false });
          bridge.answerClose("close");
          return;
        }
        const saved = await save();
        set({ closePrompt: false });
        bridge.answerClose(saved ? "close" : "cancel");
      },
    };
  });

  let dirty = selectDirty(canvas.getState());
  bridge.setDirty(dirty);
  canvas.subscribe((state) => {
    const next = selectDirty(state);
    if (next === dirty) return;
    dirty = next;
    bridge.setDirty(next);
  });

  bridge.onCloseRequest(() => store.setState({ closePrompt: true }));

  return store;
};
