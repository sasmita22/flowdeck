import { createStore, type StoreApi } from "zustand/vanilla";
import { costReportSchema, type CostReport } from "../../core/run/cost.js";
import { displayStatus, type DisplayStatus } from "../../core/run/display.js";
import { buildVersionResultSchema } from "../../core/run/listing.js";
import { runChoicesSchema, type RunChoices, type RunOptions } from "../../core/run/options.js";
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
  | "buildVersion"
  | "runBuild"
  | "getRunState"
  | "onRunState"
  | "runOptions"
  | "stopRun"
  | "retryNode"
  | "resumeRun"
  | "runCost"
>;

export type RunDialog = { hash: string; choices: RunChoices };

export type BuiltVersion = { hash: string; flowId: string; version: number };

export type RunState = {
  snapshot: RunSnapshot | null;
  starting: boolean;
  error: string | null;
  lastBuild: BuiltVersion | null;
  dialog: RunDialog | null;
  cost: { runId: string; report: CostReport } | null;
  connect(): Promise<void>;
  run(): Promise<string | null>;
  build(): Promise<string | null>;
  buildVersion(ref: { flowId: string; version: number }): Promise<string | null>;
  runBuild(hash: string): Promise<string | null>;
  start(options: RunOptions): Promise<string | null>;
  cancelDialog(): void;
  stop(runId: string): Promise<void>;
  retry(runId: string, nodeId: string): Promise<string | null>;
  resume(runId: string): Promise<string | null>;
  loadCost(runId: string): Promise<void>;
};

const offersChoices = ({ inputs, flags, automatic }: RunChoices) =>
  inputs.length > 0 || Object.keys(flags).length > 0 || automatic;

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

const summaryLabel = (
  status: RunSnapshot["status"],
  shown: readonly DisplayStatus[],
  waiting: boolean,
) => {
  if ((waiting && status === "running") || shown.includes("needs you")) return "Needs you";
  if (shown.includes("failed")) return "Failed";
  if (status === "stopped") return "Stopped";
  return status === "running" ? "Running" : "Done";
};

export const selectRunSummary = (run: Pick<RunState, "snapshot">, waiting = false): string => {
  if (run.snapshot === null) return "Idle";
  const shown = Object.values(run.snapshot.nodes).map(displayStatus);
  const done = shown.filter((status) => status === "done").length;
  return `${summaryLabel(run.snapshot.status, shown, waiting)} · ${done} of ${shown.length} nodes done`;
};

export const selectSessionStatus = (run: Pick<RunState, "snapshot">, waiting = false): string => {
  const { snapshot } = run;
  if (snapshot === null) return "idle";
  const needsYou = Object.values(snapshot.nodes).some((state) => state === "needs-you");
  return snapshot.status === "running" && (waiting || needsYou) ? "needs you" : snapshot.status;
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

    const started = (value: unknown): Step<string> => {
      const result = startRunResultSchema.safeParse(value);
      if (!result.success) return { ok: false, error: "unexpected start-run result" };
      return result.data.kind === "error"
        ? { ok: false, error: result.data.message }
        : { ok: true, value: result.data.runId };
    };

    const launch = async (hash: string): Promise<Step<string | null>> => {
      const choices = runChoicesSchema.safeParse(await bridge.runOptions({ hash }));
      if (!choices.success) return { ok: false, error: "unexpected run options" };
      if (offersChoices(choices.data)) {
        set({ dialog: { hash, choices: choices.data } });
        return { ok: true, value: null };
      }
      return started(await bridge.runBuild({ hash }));
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

    const answered = (work: () => Promise<unknown>) =>
      busy(false, async () => started(await work()));

    return {
      snapshot: null,
      starting: false,
      error: null,
      lastBuild: null,
      dialog: null,
      cost: null,

      connect: async () => {
        bridge.onRunState((value) => {
          if (show(value)) pushed = true;
        });
        const current = await bridge.getRunState();
        if (!pushed) show(current);
      },

      run: () =>
        busy(selectRunDisabled(get(), save.getState()), async (): Promise<Step<string | null>> => {
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

      start: async (options) => {
        const { dialog } = get();
        if (dialog === null) return null;
        const runId = await busy(selectRunDisabled(get(), save.getState()), async () =>
          started(await bridge.runBuild({ hash: dialog.hash, ...options })),
        );
        if (runId !== null) set({ dialog: null });
        return runId;
      },

      cancelDialog: () => set({ dialog: null }),

      stop: async (runId) => {
        try {
          await bridge.stopRun({ runId });
        } catch (thrown) {
          set({ error: messageOf(thrown) });
        }
      },

      retry: (runId, nodeId) => answered(() => bridge.retryNode({ runId, nodeId })),

      resume: (runId) => answered(() => bridge.resumeRun({ runId })),

      loadCost: async (runId) => {
        try {
          const report = costReportSchema.parse(await bridge.runCost({ runId }));
          set({ cost: { runId, report } });
        } catch (thrown) {
          set({ error: messageOf(thrown) });
        }
      },
    };
  });
