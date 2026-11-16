import { z } from "zod";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { Problem } from "../../core/compiler/problems.js";
import { openedFlowSchema } from "../../core/flow/flow-store.js";
import { mainFlow } from "../../core/flow/main-flow.js";
import type { BuildConfig, Variable } from "../../core/flow/schema.js";
import { unsetVariables } from "../../core/flow/variables.js";
import {
  isValidBranchName,
  recommendedBranch,
  type RequestBranch,
} from "../../core/run/branch-name.js";
import { costReportSchema, type CostReport } from "../../core/run/cost.js";
import {
  deleteBuildResultSchema,
  deletePreviewSchema,
  type DeletePreview,
  type KeptAfterDelete,
} from "../../core/run/delete-build.js";
import { displayStatus, type DisplayStatus } from "../../core/run/display.js";
import { buildVersionResultSchema, writeStoryResultSchema } from "../../core/run/listing.js";
import { pipelineSchema, type PipelineItem } from "../../core/run/pipeline.js";
import { runChoicesSchema } from "../../core/run/options.js";
import {
  runSnapshotSchema,
  startRunResultSchema,
  type RunSnapshot,
  type SnapshotStatus,
} from "../../core/run/snapshot.js";
import type { FlowdeckBridge } from "../preload/bridge.js";
import { selectDirty, type CanvasState } from "./canvas/store.js";
import { labelFor } from "../../core/nodes/defaults.js";
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
  | "runPipeline"
  | "deleteBuild"
  | "deleteRun"
  | "deletePendingBuild"
  | "deletePreview"
  | "writeStory"
  | "defaultBranch"
  | "listBranches"
  | "checkedOutBranches"
  | "openFlow"
>;

export type RunChoice = { auto: boolean };

export type RunDialog = { buildId: string };

export type IgnoredNode = { id: string; label: string };

export type BranchMode = "new" | "existing";

export type ExistingBranch = { name: string; reason: string | null };

export type BuildDialog = {
  flowId: string;
  version: number;
  name: string;
  repo: string;
  base: string;
  variables: Variable[];
  values: Record<string, string | boolean>;
  buildModel: string;
  branches: string[];
  checkedOut: Record<string, string>;
  branchMode: BranchMode;
  branchName: string;
  branchNameEdited: boolean;
  existingBranch: string | null;
  ignored: readonly IgnoredNode[];
  step: "form" | "confirm";
  error: string | null;
};

type BuildDialogEdit = Partial<
  Pick<
    BuildDialog,
    "name" | "repo" | "base" | "buildModel" | "branchMode" | "branchName" | "existingBranch"
  >
>;

export type BuildSource = { flowId: string; version: number; buildConfig: BuildConfig };

export type BuildCardRun = {
  old: boolean;
  run: { id: string; status: SnapshotStatus } | null;
};

export type KeptBuild = { buildId: string } & KeptAfterDelete;

export type StageSelection = { nodeId: string; round?: number };

export type DeleteQuestion =
  | { kind: "build"; id: string }
  | { kind: "pending"; id: string }
  | { kind: "run"; id: string; from: "runs" | "run-page" };

export type ConfirmingDelete =
  | { kind: "build"; id: string; preview: DeletePreview }
  | Exclude<DeleteQuestion, { kind: "build" }>;

export type RunState = {
  snapshots: Record<string, RunSnapshot>;
  latestRunId: string | null;
  starting: boolean;
  error: string | null;
  problems: Problem[] | null;
  buildDialog: BuildDialog | null;
  dialog: RunDialog | null;
  kept: KeptBuild | null;
  cost: { runId: string; report: CostReport } | null;
  pipelines: Record<string, PipelineItem[] | null>;
  selectedStage: Record<string, StageSelection>;
  menuOpen: string | null;
  confirmingDelete: ConfirmingDelete | null;
  writingStory: Record<string, true>;
  storyErrors: Record<string, string>;
  connect(): Promise<void>;
  view(runId: string): Promise<void>;
  openBuild(source?: BuildSource): Promise<void>;
  editBuild(patch: BuildDialogEdit): void;
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
  loadPipeline(runId: string): Promise<void>;
  selectStage(runId: string, stage: StageSelection): void;
  openMenu(key: string): void;
  closeMenu(): void;
  askDelete(question: DeleteQuestion): Promise<void>;
  cancelDelete(): void;
  deleteRun(runId: string): Promise<boolean>;
  deletePendingBuild(id: string): Promise<boolean>;
  writeStory(runId: string): Promise<void>;
  isWritingStory(runId: string): boolean;
  storyErrorFor(runId: string): string | undefined;
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
  return card.blueprint === ""
    ? "Builds from before named builds can't run again."
    : "Make a new build from this blueprint";
};

export const selectExistingBranches = (run: Pick<RunState, "buildDialog">): ExistingBranch[] => {
  const dialog = run.buildDialog;
  if (dialog === null) return [];
  return dialog.branches.map((name) => {
    const path = dialog.checkedOut[name];
    return { name, reason: path === undefined ? null : `Checked out in ${path}` };
  });
};

const chosenBranch = (dialog: BuildDialog): RequestBranch | null => {
  if (dialog.branchMode === "new") {
    const name = dialog.branchName;
    return isValidBranchName(name) ? { mode: "new", name, base: dialog.base } : null;
  }
  const name = dialog.existingBranch;
  const free = name !== null && dialog.branches.includes(name) && !(name in dialog.checkedOut);
  return free ? { mode: "existing", name } : null;
};

export const selectCanBuild = (run: Pick<RunState, "buildDialog">): boolean => {
  const dialog = run.buildDialog;
  if (dialog === null) return false;
  return (
    dialog.name.trim() !== "" &&
    dialog.repo !== "" &&
    (dialog.branchMode === "existing" || dialog.base !== "") &&
    chosenBranch(dialog) !== null &&
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
  if (status === "running" && (waiting || shown.includes("needs you"))) return "Needs you";
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

const without = <T>(record: Record<string, T>, key: string): Record<string, T> =>
  Object.fromEntries(Object.entries(record).filter(([kept]) => kept !== key));

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

    const branchesSchema = z.array(z.string());
    const checkedOutSchema = z.record(z.string(), z.string());

    const repoBranches = async (
      repo: string,
    ): Promise<Pick<BuildDialog, "branches" | "checkedOut">> => {
      if (repo === "") return { branches: [], checkedOut: {} };
      const [branches, checkedOut] = await Promise.all([
        bridge.listBranches({ repo }).then((answer) => branchesSchema.parse(answer)),
        bridge.checkedOutBranches({ repo }).then((answer) => checkedOutSchema.parse(answer)),
      ]).catch(() => [[], {}] as const);
      return { branches: [...branches], checkedOut: { ...checkedOut } };
    };

    const followName = (dialog: BuildDialog): BuildDialog =>
      dialog.branchNameEdited
        ? dialog
        : { ...dialog, branchName: recommendedBranch(dialog.name, dialog.branches) };

    const ignoredIn = async (flowId: string): Promise<IgnoredNode[]> => {
      const flow = openedFlowSchema.nullable().parse(await bridge.openFlow({ flowId }))?.flow;
      const main = flow ? mainFlow(flow) : undefined;
      return (main?.ignored ?? []).map((node) => ({ id: node.id, label: labelFor(node) }));
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
      buildDialog: null,
      dialog: null,
      kept: null,
      cost: null,
      pipelines: {},
      selectedStage: {},
      menuOpen: null,
      confirmingDelete: null,
      writingStory: {},
      storyErrors: {},

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
        const repo = buildConfig.repo ?? "";
        const [base, ignored, { branches, checkedOut }] = await Promise.all([
          startingBase(buildConfig),
          ignoredIn(flowId),
          repoBranches(repo),
        ]);
        set({
          error: null,
          buildDialog: {
            flowId,
            version,
            name: "",
            repo,
            base,
            variables: buildConfig.variables,
            values: defaults(buildConfig.variables),
            buildModel: buildConfig.buildModel ?? "",
            branches,
            checkedOut,
            branchMode: "new",
            branchName: recommendedBranch("", branches),
            branchNameEdited: false,
            existingBranch: null,
            ignored,
            step: "form",
            error: null,
          },
        });
      },

      editBuild: (patch) => {
        const { repo } = patch;
        const moved = repo !== undefined && repo !== get().buildDialog?.repo;
        editDialog((dialog) =>
          followName({
            ...dialog,
            ...(moved && { base: "", branches: [], checkedOut: {}, existingBranch: null }),
            ...patch,
            branchNameEdited: dialog.branchNameEdited || patch.branchName !== undefined,
          }),
        );
        if (!moved) return;
        void repoBranches(repo).then((loaded) => {
          const dialog = get().buildDialog;
          if (dialog?.repo !== repo) return;
          set({ buildDialog: followName({ ...dialog, ...loaded }) });
        });
        if (get().buildDialog?.base !== "") return;
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
        const branch = chosenBranch(dialog);
        if (branch === null) return null;
        if (dialog.step === "form" && dialog.ignored.length > 0) {
          set({ buildDialog: { ...dialog, step: "confirm", error: null } });
          return null;
        }
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
            ...(base === "" ? {} : { base }),
            branch,
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
        set({ starting: false, error: null, problems: null, buildDialog: null });
        return result.data.id;
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

      loadPipeline: async (runId) => {
        try {
          const pipeline = pipelineSchema.nullable().parse(await bridge.runPipeline({ runId }));
          set({ pipelines: { ...get().pipelines, [runId]: pipeline } });
        } catch (thrown) {
          set({ error: messageOf(thrown) });
        }
      },

      selectStage: (runId, stage) =>
        set({ selectedStage: { ...get().selectedStage, [runId]: stage } }),

      openMenu: (key) => set({ menuOpen: key }),

      closeMenu: () => set({ menuOpen: null }),

      askDelete: async (question) => {
        if (question.kind !== "build") {
          set({ confirmingDelete: question });
          return;
        }
        try {
          const preview = deletePreviewSchema.parse(
            await bridge.deletePreview({ buildId: question.id }),
          );
          set({ confirmingDelete: { ...question, preview } });
        } catch (thrown) {
          set({ error: messageOf(thrown) });
        }
      },

      cancelDelete: () => set({ confirmingDelete: null }),

      deleteRun: async (runId) => {
        try {
          await bridge.deleteRun({ runId });
          if (get().latestRunId === runId) set({ latestRunId: null });
          return true;
        } catch (thrown) {
          set({ error: messageOf(thrown) });
          return false;
        }
      },

      deletePendingBuild: async (id) => {
        try {
          await bridge.deletePendingBuild({ id });
          return true;
        } catch (thrown) {
          set({ error: messageOf(thrown) });
          return false;
        }
      },

      writeStory: async (runId) => {
        if (get().isWritingStory(runId)) return;
        set({ writingStory: { ...get().writingStory, [runId]: true } });
        let error: string | undefined;
        try {
          const result = writeStoryResultSchema.parse(await bridge.writeStory({ runId }));
          if (!result.ok) error = result.error;
        } catch (thrown) {
          error = messageOf(thrown);
        }
        const { writingStory, storyErrors } = get();
        set({
          writingStory: without(writingStory, runId),
          storyErrors:
            error === undefined ? without(storyErrors, runId) : { ...storyErrors, [runId]: error },
        });
      },

      isWritingStory: (runId) => get().writingStory[runId] === true,

      storyErrorFor: (runId) => get().storyErrors[runId],
    };
  });
