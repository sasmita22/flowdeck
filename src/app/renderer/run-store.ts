import { createStore, type StoreApi } from "zustand/vanilla";
import { displayStatus, type DisplayStatus } from "../../core/run/display.js";
import {
  runSnapshotSchema,
  startRunResultSchema,
  type RunSnapshot,
} from "../../core/run/snapshot.js";
import type { FlowdeckBridge } from "../preload/bridge.js";
import { selectDirty, type CanvasState } from "./canvas/store.js";
import type { SaveState } from "./save-store.js";

export type RunBridge = Pick<FlowdeckBridge, "startRun" | "getRunState" | "onRunState">;

export type RunState = {
  snapshot: RunSnapshot | null;
  starting: boolean;
  error: string | null;
  connect(): Promise<void>;
  run(): Promise<void>;
};

export const selectRunDisabled = (
  run: Pick<RunState, "starting" | "snapshot">,
  save: Pick<SaveState, "saving">,
): boolean => run.starting || save.saving || run.snapshot?.status === "running";

export const selectNodeDisplay = (
  run: Pick<RunState, "snapshot">,
  nodeId: string,
): DisplayStatus | null => {
  const state = run.snapshot?.nodes[nodeId];
  return state === undefined ? null : displayStatus(state);
};

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export const createRunStore = ({
  bridge,
  save,
  canvas,
}: {
  bridge: RunBridge;
  save: StoreApi<SaveState>;
  canvas: StoreApi<CanvasState>;
}): StoreApi<RunState> =>
  createStore<RunState>()((set, get) => {
    let pushed = false;

    const show = (value: unknown): boolean => {
      const parsed = runSnapshotSchema.safeParse(value);
      if (parsed.success) set({ snapshot: parsed.data });
      return parsed.success;
    };

    const saveFirst = (): Promise<boolean> => {
      const saver = save.getState();
      if (selectDirty(canvas.getState())) return saver.save();
      if (!saver.hasSavedVersion) return saver.save({ force: true });
      return Promise.resolve(true);
    };

    const start = async (): Promise<string | null> => {
      if (!(await saveFirst())) return save.getState().error ?? "The flow could not be saved";
      const result = startRunResultSchema.safeParse(await bridge.startRun());
      if (!result.success) return "unexpected start-run result";
      return result.data.kind === "error" ? result.data.message : null;
    };

    return {
      snapshot: null,
      starting: false,
      error: null,

      connect: async () => {
        bridge.onRunState((value) => {
          if (show(value)) pushed = true;
        });
        const current = await bridge.getRunState();
        if (!pushed) show(current);
      },

      run: async () => {
        if (selectRunDisabled(get(), save.getState())) return;
        set({ starting: true });
        let error: string | null;
        try {
          error = await start();
        } catch (thrown) {
          error = messageOf(thrown);
        }
        set({ starting: false, error });
      },
    };
  });
