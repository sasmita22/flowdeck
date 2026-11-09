import { z } from "zod";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { Problem } from "../../core/compiler/problems.js";
import type { BuildConfig, Variable } from "../../core/flow/schema.js";
import { unsetVariables } from "../../core/flow/variables.js";
import { costReportSchema, type CostReport } from "../../core/run/cost.js";
import { deleteBuildResultSchema, type KeptAfterDelete } from "../../core/run/delete-build.js";
import { displayStatus, type DisplayStatus } from "../../core/run/display.js";
import { buildVersionResultSchema } from "../../core/run/listing.js";
import { runChoicesSchema } from "../../core/run/options.js";
import {
  runSnapshotSchema,
  startRunResultSchema,
  type RunSnapshot,
  type SnapshotStatus,
} from "../../core/run/snapshot.js";
import type { FlowdeckBridge } from "../preload/bridge.js";
import { selectDirty, type CanvasState } from "./canvas/store.js";
import { noBlueprint } from "./library-store.js";
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
  | "deleteBuild"
  | "defaultBranch"
>;

export type RunChoice = { auto: boolean };

export type RunDialog = { buildId: string };

export type BuildDialog = {
  flowId: string;
  version: number;
  name: string;
  repo: string;
  base: string;
  variables: Variable[];
  values: Record<string, string | boolean>;
  buildModel: string;
  error: string | null;
};

export type BuildSource = { flowId: string; version: number; buildConfig: BuildConfig };

export type BuiltVersion = { id: string; name: string; flowId: string; version: number };

export type BuildCardRun = {
  old: boolean;
  run: { id: string; status: SnapshotStatus } | null;
};

export type KeptBuild = { buildId: string } & KeptAfterDelete;

export type RunState = {
  snapshots: Record<string, RunSnapshot>;
  latestRunId: string | null;
  starting: boolean;
  error: string | null;
  problems: Problem[] | null;
  lastBuild: BuiltVersion | null;
  buildDialog: BuildDialog | null;
  dialog: RunDialog | null;
  kept: KeptBuild | null;
  cost: { runId: string; report: CostReport } | null;
  connect(): Promise<void>;
  view(runId: string): Promise<void>;
  openBuild(source?: BuildSource): Promise<void>;
  editBuild(patch: Partial<Pick<BuildDialog, "name" | "repo" | "base" | "buildModel">>): void;
  setValue(name: string, value: string | boolean): void;
  confirmBuild(): Promise<string | null>;
  cancelBuild(): void;
  runBuild(buildId: string): Promise<string | null>;
  start(choice: RunChoice): Promise<string | null>;
  cancelDialog(): void;
  dismissProblems(): void;
  deleteBuild(buildId: string): Promise<boolean>;
  stop(runId: string): Promise<void>;
  retry(runId: string, nodeId: string): Promise<string | null>;
  resume(runId: string): Promise<string | null>;
  loadCost(runId: string): Promise<void>;
};

export type RunView = { snapshot: RunSnapshot | null };

export const selectRunSnapshot = (
  run: Pick<RunState, "snapshots">,
  runId: string,
): RunSnapshot | null => run.snapshots[runId] ?? null;

export const selectLatestSnapshot = (
  run: Pick<RunState, "snapshots" | "latestRunId">,
): RunSnapshot | null =>
  run.latestRunId === null ? null : selectRunSnapshot(run, run.latestRunId);

export const selectRunningCount = (run: Pick<RunState, "snapshots">): number =>
  Object.values(run.snapshots).filter(({ status }) => status === "running").length;

const blockingStatuses: readonly SnapshotStatus[] = ["running", "interrupted"];

export const selectRunDisabled = (
  run: Pick<RunState, "starting" | "snapshots">,
  card: BuildCardRun,
): boolean => {
  if (run.starting || card.old) return true;
  if (card.run === null) return false;
  const status = run.snapshots[card.run.id]?.status ?? card.run.status;
  return blockingStatuses.includes(status);
};

export const selectRunHint = (card: { old: boolean; blueprint: string }): string | null => {
  if (!card.old) return null;
  return card.blueprint === noBlueprint
    ? "Builds from before named builds can't run again."
    : "Make a new build from this blueprint";
};

export const selectCanBuild = (run: Pick<RunState, "buildDialog">): boolean => {
  const dialog = run.buildDialog;
  if (dialog === null) return false;
  return (
    dialog.name.trim() !== "" &&
    dialog.repo !== "" &&
    dialog.base !== "" &&
    unsetVariables({ variables: dialog.variables }, dialog.values).length === 0
  );
};

export const selectNodeDisplay = (run: RunView, nodeId: string): DisplayStatus | null => {
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

export const selectRunSummary = (run: RunView, waiting = false): string => {
  if (run.snapshot === null) return "Idle";
  const shown = Object.values(run.snapshot.nodes).map(displayStatus);
  const done = shown.filter((status) => status === "done").length;
  return `${summaryLabel(run.snapshot.status, shown, waiting)} · ${done} of ${shown.length} nodes done`;
};

export const selectSessionStatus = (run: RunView, waiting = false): string => {
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

export const needsSessionSetup = (problems: readonly Problem[] | null): boolean =>
  problems?.some(({ node, field }) => node === undefined && field !== undefined) ?? false;

export const selectKeptNote = (kept: KeptBuild): string => {
  switch (kept.kind) {
    case "worktree":
      return `The build is deleted. Its worktree held work, so it was kept at ${kept.path}`;
    case "branch":
      return `The build is deleted. Its branch ${kept.branch} holds commits, so it was kept.`;
    case "folder":
      return `The build is deleted. Its folder ${kept.path} is outside FLOWDECK_HOME, so it was left in place.`;
  }
};

const defaults = (variables: readonly Variable[]): Record<string, string | boolean> =>
  Object.fromEntries(
    variables.flatMap((variable) =>
      variable.default === undefined ? [] : [[variable.name, variable.default]],
    ),
  );

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
    const saveFirst = (): Promise<boolean> => {
      const saver = save.getState();
      if (selectDirty(canvas.getState())) return saver.save();
      if (!saver.hasSavedVersion) return saver.save({ force: true });
      return Promise.resolve(true);
    };

    const savedSource = async (): Promise<BuildSource | null> => {
      if (!(await saveFirst())) {
        set({ error: save.getState().error ?? "The blueprint could not be saved" });
        return null;
      }
      const { flowId, version } = save.getState();
      if (flowId === null || version === null) {
        set({ error: "Save the blueprint before building it" });
        return null;
      }
      return { flowId, version, buildConfig: canvas.getState().flow.session.buildConfig };
    };

    const startingBase = async ({ repo, base }: BuildConfig): Promise<string> => {
      if (base !== undefined) return base;
      if (repo === undefined || repo === "") return "";
      const answer = z.string().safeParse(await bridge.defaultBranch({ repo }));
      return answer.success ? answer.data : "";
    };

    const editDialog = (edit: (dialog: BuildDialog) => BuildDialog) => {
      const { buildDialog } = get();
      if (buildDialog !== null) set({ buildDialog: { ...edit(buildDialog), error: null } });
    };

    type Step<T> =
      { ok: true; value: T } | { ok: false; error: string; problems?: Problem[] | undefined };

    const started = (value: unknown): Step<string> => {
      const result = startRunResultSchema.safeParse(value);
      if (!result.success) return { ok: false, error: "unexpected start-run result" };
      return result.data.kind === "error"
        ? { ok: false, error: result.data.message }
        : { ok: true, value: result.data.runId };
    };

    const launch = async (buildId: string): Promise<Step<string | null>> => {
      const choices = runChoicesSchema.safeParse(await bridge.runOptions({ buildId }));
      if (!choices.success) return { ok: false, error: "unexpected run options" };
      if (choices.data.automatic) {
        set({ dialog: { buildId } });
        return { ok: true, value: null };
      }
      return started(await bridge.runBuild({ buildId }));
    };

    const busy = async <T>(work: () => Promise<Step<T>>): Promise<T | null> => {
      if (get().starting) return null;
      set({ starting: true });
      let step: Step<T>;
      try {
        step = await work();
      } catch (thrown) {
        step = { ok: false, error: messageOf(thrown) };
      }
      const problems = step.ok ? undefined : step.problems;
      set({
        starting: false,
        error: step.ok || problems !== undefined ? null : step.error,
        problems: problems ?? null,
      });
      return step.ok ? step.value : null;
    };

    const answered = (work: () => Promise<unknown>) => busy(async () => started(await work()));

    return {
      snapshots: {},
      latestRunId: null,
      starting: false,
      error: null,
      problems: null,
      lastBuild: null,
      buildDialog: null,
      dialog: null,
      kept: null,
      cost: null,

      connect: async () => {
        bridge.onRunState((value) => {
          const parsed = runSnapshotSchema.safeParse(value);
          if (!parsed.success) return;
          const snapshot = parsed.data;
          set({
            snapshots: { ...get().snapshots, [snapshot.runId]: snapshot },
            latestRunId: snapshot.runId,
          });
        });
      },

      view: async (runId) => {
        const fetched = runSnapshotSchema.safeParse(await bridge.getRunState(runId));
        if (!fetched.success || fetched.data.runId !== runId) return;
        if (get().snapshots[runId] !== undefined) return;
        set({ snapshots: { ...get().snapshots, [runId]: fetched.data } });
      },

      openBuild: async (source) => {
        const opened = source ?? (await savedSource());
        if (opened === null) return;
        const { flowId, version, buildConfig } = opened;
        const base = await startingBase(buildConfig);
        set({
          error: null,
          buildDialog: {
            flowId,
            version,
            name: "",
            repo: buildConfig.repo ?? "",
            base,
            variables: buildConfig.variables,
            values: defaults(buildConfig.variables),
            buildModel: buildConfig.buildModel ?? "",
            error: null,
          },
        });
      },

      editBuild: (patch) => {
        const { repo } = patch;
        const moved = repo !== undefined && repo !== get().buildDialog?.repo;
        editDialog((dialog) => ({ ...dialog, ...(moved && { base: "" }), ...patch }));
        if (!moved || get().buildDialog?.base !== "") return;
        void startingBase({ repo, variables: [] })
          .catch(() => "")
          .then((base) => {
            const dialog = get().buildDialog;
            if (dialog?.repo !== repo || dialog.base !== "") return;
            set({ buildDialog: { ...dialog, base } });
          });
      },

      setValue: (name, value) =>
        editDialog((dialog) => ({ ...dialog, values: { ...dialog.values, [name]: value } })),

      confirmBuild: async () => {
        const dialog = get().buildDialog;
        if (dialog === null || !selectCanBuild(get()) || get().starting) return null;
        const { flowId, version, name, repo, base, values } = dialog;
        const buildModel = dialog.buildModel.trim();
        set({ starting: true });
        const refuse = (error: string, problems: Problem[] | null = null) => {
          set({ starting: false, problems, buildDialog: { ...dialog, error } });
          return null;
        };
        let answer: unknown;
        try {
          answer = await bridge.buildVersion({
            flowId,
            version,
            name,
            repo,
            base,
            values,
            ...(buildModel === "" ? {} : { buildModel }),
          });
        } catch (thrown) {
          return refuse(messageOf(thrown));
        }
        const result = buildVersionResultSchema.safeParse(answer);
        if (!result.success) return refuse("unexpected build result");
        if (result.data.kind === "error") {
          return refuse(result.data.message, result.data.problems ?? null);
        }
        if (result.data.kind === "started") {
          set({ starting: false, error: null, problems: null, buildDialog: null });
          return result.data.pendingId;
        }
        const { id } = result.data;
        set({
          starting: false,
          error: null,
          problems: null,
          buildDialog: null,
          lastBuild: { id, name, flowId, version },
        });
        return id;
      },

      cancelBuild: () => set({ buildDialog: null }),

      runBuild: (buildId) => busy(() => launch(buildId)),

      start: async ({ auto }) => {
        const { dialog } = get();
        if (dialog === null) return null;
        const runId = await busy(async () =>
          started(await bridge.runBuild({ buildId: dialog.buildId, auto })),
        );
        if (runId !== null) set({ dialog: null });
        return runId;
      },

      cancelDialog: () => set({ dialog: null }),

      dismissProblems: () => set({ problems: null }),

      deleteBuild: async (buildId) => {
        try {
          const result = deleteBuildResultSchema.parse(await bridge.deleteBuild({ buildId }));
          if (!result.ok) {
            set({ kept: null, error: result.message });
            return false;
          }
          set({
            kept: result.kept === undefined ? null : { buildId, ...result.kept },
            error: null,
          });
          return true;
        } catch (thrown) {
          set({ kept: null, error: messageOf(thrown) });
          return false;
        }
      },

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
