import { createStore, type StoreApi } from "zustand/vanilla";
import { openedFlowSchema, saveFlowResultSchema } from "../../core/flow/flow-store.js";
import type { FlowdeckBridge } from "../preload/bridge.js";
import { newCanvasFlow, selectDirty, type CanvasState } from "./canvas/store.js";

export type SaveBridge = Pick<
  FlowdeckBridge,
  "saveFlow" | "openFlow" | "renameFlow" | "setDirty" | "onCloseRequest" | "answerClose"
>;

export type CloseChoice = "save" | "discard" | "cancel";

export const untitled = "Untitled";

export type SaveState = {
  saving: boolean;
  error: string | null;
  closePrompt: boolean;
  leavePrompt: boolean;
  hasSavedVersion: boolean;
  flowId: string | null;
  name: string;
  version: number | null;
  open(flowId?: string): Promise<void>;
  startNew(): void;
  rename(name: string): Promise<void>;
  save(options?: { force?: boolean }): Promise<boolean>;
  leave(next: () => Promise<void>): Promise<void>;
  answerLeave(answer: CloseChoice): Promise<void>;
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
  let pendingLeave: (() => Promise<void>) | null = null;

  const store = createStore<SaveState>()((set, get) => {
    const fail = (message: string) => {
      set({ saving: false, error: message });
      return false;
    };

    const save = async (options: { force?: boolean } = {}) => {
      if (get().saving) return false;
      if (options.force !== true && !selectDirty(canvas.getState())) return true;
      const sent = canvas.getState().flow;
      const { flowId, name } = get();
      set({ saving: true, error: null });
      let reply: unknown;
      try {
        reply = await bridge.saveFlow({ flowId, name, flow: sent });
      } catch (error) {
        return fail(messageOf(error));
      }
      const result = saveFlowResultSchema.safeParse(reply);
      if (!result.success) return fail("unexpected save result");
      if (result.data.kind === "error") return fail(result.data.message);
      canvas.getState().markSaved(sent);
      set({
        saving: false,
        hasSavedVersion: true,
        flowId: result.data.flowId,
        version: result.data.version,
      });
      return true;
    };

    return {
      saving: false,
      error: null,
      closePrompt: false,
      leavePrompt: false,
      hasSavedVersion: false,
      flowId: null,
      name: untitled,
      version: null,

      open: async (flowId) => {
        try {
          const reply = await bridge.openFlow(flowId === undefined ? {} : { flowId });
          const opened = reply === null ? null : openedFlowSchema.parse(reply);
          canvas.getState().load(opened?.flow ?? newCanvasFlow());
          set({
            error: null,
            flowId: opened?.flowId ?? null,
            name: opened?.name ?? untitled,
            version: opened?.version ?? null,
            hasSavedVersion: (opened?.version ?? null) !== null,
          });
        } catch (error) {
          set({ error: messageOf(error) });
        }
      },

      startNew: () => {
        canvas.getState().load(newCanvasFlow());
        set({ error: null, flowId: null, name: untitled, version: null, hasSavedVersion: false });
      },

      rename: async (name) => {
        const { flowId } = get();
        if (flowId === null) {
          if (name.trim() !== "") set({ name: name.trim(), error: null });
          return;
        }
        try {
          await bridge.renameFlow({ flowId, name });
          set({ name: name.trim(), error: null });
        } catch (error) {
          set({ error: messageOf(error) });
        }
      },

      save,

      leave: async (next) => {
        if (!selectDirty(canvas.getState())) {
          await next();
          return;
        }
        pendingLeave = next;
        set({ leavePrompt: true });
      },

      answerLeave: async (answer) => {
        const next = pendingLeave;
        pendingLeave = null;
        if (answer === "cancel" || next === null) {
          set({ leavePrompt: false });
          return;
        }
        const saved = answer === "discard" || (await save());
        set({ leavePrompt: false });
        if (saved) await next();
      },

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
