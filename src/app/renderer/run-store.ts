import { createStore, type StoreApi } from "zustand/vanilla";
import { displayStatus, type DisplayStatus } from "../../core/run/display.js";
import { buildVersionResultSchema } from "../../core/run/listing.js";
import {
  runSnapshotSchema,
  startRunResultSchema,
  type RunSnapshot,
} from "../../core/run/snapshot.js";
import type { FlowdeckBridge } from "../preload/bridge.js";
import { selectDirty, type CanvasState } from "./canvas/store.js";
import type { SaveState } from "./save-store.js";

export type RunBridge = Pick<
  FlowdeckBridge,
  "buildVersion" | "runBuild" | "getRunState" | "onRunState"
>;

export type BuiltVersion = { hash: string; flowId: string; version: number };

export type RunState = {
  snapshot: RunSnapshot | null;
  starting: boolean;
  error: string | null;
  lastBuild: BuiltVersion | null;
  connect(): Promise<void>;
  run(): Promise<string | null>;
  build(): Promise<string | null>;
  buildVersion(ref: { flowId: string; version: number }): Promise<string | null>;
  runBuild(hash: string): Promise<string | null>;
};

export type RunView = Pick<RunState, "snapshot">;

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

const summaryLabel = (status: RunSnapshot["status"], shown: readonly DisplayStatus[]) => {
  if (shown.includes("needs you")) return "Needs you";
  if (shown.includes("failed")) return "Failed";
  return status === "running" ? "Running" : "Done";
};

export const selectRunSummary = (run: Pick<RunState, "snapshot">): string => {
  if (run.snapshot === null) return "Idle";
  const shown = Object.values(run.snapshot.nodes).map(displayStatus);
  const done = shown.filter((status) => status === "done").length;
  return `${summaryLabel(run.snapshot.status, shown)} · ${done} of ${shown.length} nodes done`;
};

export const selectLiveBadge = (snapshot: RunSnapshot | null): string | null => {
  if (snapshot?.status !== "running") return null;
  const shown = Object.values(snapshot.nodes).map(displayStatus);
  if (shown.includes("needs you")) return "needs you";
  return `running · ${shown.filter((status) => status === "done").length} of ${shown.length}`;
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

    type Step<T> = { ok: true; value: T } | { ok: false; error: string };

    const buildRef = async (ref: {
      flowId: string;
      version: number;
    }): Promise<Step<BuiltVersion>> => {
      const result = buildVersionResultSchema.safeParse(await bridge.buildVersion(ref));
      if (!result.success) return { ok: false, error: "unexpected build result" };
      if (result.data.kind === "error") return { ok: false, error: result.data.message };
      const built = { hash: result.data.hash, ...ref };
      set({ lastBuild: built });
      return { ok: true, value: built };
    };

    const buildSaved = async (): Promise<Step<BuiltVersion>> => {
      if (!(await saveFirst())) {
        return { ok: false, error: save.getState().error ?? "The blueprint could not be saved" };
      }
      const { flowId, version } = save.getState();
      if (flowId === null || version === null) {
        return { ok: false, error: "Save the blueprint before building it" };
      }
      return buildRef({ flowId, version });
    };

    const launch = async (hash: string): Promise<Step<string>> => {
      const result = startRunResultSchema.safeParse(await bridge.runBuild({ hash }));
      if (!result.success) return { ok: false, error: "unexpected start-run result" };
      return result.data.kind === "error"
        ? { ok: false, error: result.data.message }
        : { ok: true, value: result.data.runId };
    };

    const busy = async <T>(blocked: boolean, work: () => Promise<Step<T>>): Promise<T | null> => {
      if (blocked) return null;
      set({ starting: true });
      let step: Step<T>;
      try {
        step = await work();
      } catch (thrown) {
        step = { ok: false, error: messageOf(thrown) };
      }
      set({ starting: false, error: step.ok ? null : step.error });
      return step.ok ? step.value : null;
    };

    return {
      snapshot: null,
      starting: false,
      error: null,
      lastBuild: null,

      connect: async () => {
        bridge.onRunState((value) => {
          if (show(value)) pushed = true;
        });
        const current = await bridge.getRunState();
        if (!pushed) show(current);
      },

      run: () =>
        busy(selectRunDisabled(get(), save.getState()), async () => {
          const built = await buildSaved();
          return built.ok ? launch(built.value.hash) : built;
        }),

      build: async () => {
        const built = await busy(get().starting || save.getState().saving, buildSaved);
        return built?.hash ?? null;
      },

      buildVersion: async (ref) => {
        const built = await busy(get().starting, () => buildRef(ref));
        return built?.hash ?? null;
      },

      runBuild: (hash) => busy(selectRunDisabled(get(), save.getState()), () => launch(hash)),
    };
  });
