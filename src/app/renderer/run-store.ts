import { z } from "zod";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { Problem } from "../../core/compiler/problems.js";
import { openedFlowSchema } from "../../core/flow/flow-store.js";
import { labelPrefix, type LibraryLookup } from "../../core/flow/libraries.js";
import { mainFlow } from "../../core/flow/main-flow.js";
import { Flow, type BuildConfig } from "../../core/flow/schema.js";
import {
  foundVariables,
  groupVariables,
  type FoundVariable,
  type LibraryUse,
} from "../../core/flow/variables.js";
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
import {
  pipelineItemSchema,
  type ContainerStatus,
  type PipelineGroup,
  type PipelineItem,
} from "../../core/run/pipeline.js";
import { sessionFailureOf } from "../../core/run/session-watch.js";
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
import { buildTarget, sessionFolder, type BuildTarget } from "./workspace-store.js";

type RunBridge = Pick<
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
  | "onRunSessions"
  | "deleteBuild"
  | "deleteRun"
  | "deletePendingBuild"
  | "deletePreview"
  | "deletePendingPreview"
  | "writeStory"
  | "defaultBranch"
  | "listBranches"
  | "checkedOutBranches"
  | "openFlow"
  | "expandFlow"
>;

export type RunChoice = { auto: boolean };

type RunDialog = { buildId: string };

type IgnoredNode = { id: string; label: string };

export type BranchMode = "new" | "existing";

type ExistingBranch = { name: string; reason: string | null };

export type BuildDialog = {
  flowId: string;
  version: number;
  name: string;
  repo: string;
  base: string;
  variables: FoundVariable[];
  values: Record<string, string | boolean>;
  buildModel: string;
  branches: string[];
  checkedOut: Record<string, string>;
  branchMode: BranchMode;
  branchName: string;
  branchNameEdited: boolean;
  existingBranch: string | null;
  ignored: readonly IgnoredNode[];
  target: BuildTarget;
  step: "form" | "confirm";
  error: string | null;
  problem: string | null;
};

type BuildDialogEdit = Partial<
  Pick<
    BuildDialog,
    "name" | "repo" | "base" | "buildModel" | "branchMode" | "branchName" | "existingBranch"
  >
>;

type BuildSource = {
  flowId: string;
  version: number;
  buildConfig: BuildConfig;
  variables: FoundVariable[];
  problem?: string;
};

type VariableGroup = {
  path: string | null;
  heading: string | null;
  variables: FoundVariable[];
};

export const variableGroups = (variables: readonly FoundVariable[]): VariableGroup[] => {
  const used = new Map<string, VariableGroup>();
  for (const variable of variables) {
    if (variable.group === undefined) continue;
    const { path, name } = variable.group;
    const group = used.get(path) ?? { path, heading: `${path} · ${name}`, variables: [] };
    group.variables.push(variable);
    used.set(path, group);
  }
  return [
    {
      path: null,
      heading: null,
      variables: variables.filter((variable) => variable.group === undefined),
    },
    ...[...used.values()].sort((a, b) => (a.path ?? "").localeCompare(b.path ?? "")),
  ];
};

const expandAnswerSchema = z.union([
  z.object({ problem: z.string() }),
  z.object({
    flow: Flow,
    uses: z.array(
      z.object({
        path: z.string(),
        name: z.string(),
        kind: z.enum(["node-library", "session-library"]),
      }),
    ),
  }),
]);

const unexpandable = "The libraries could not be expanded";

const usedLibraries = (flow: Flow, uses: readonly LibraryUse[]): LibraryLookup => {
  const byId = new Map(
    flow.nodes.flatMap((node) => {
      if (node.type !== "library") return [];
      const use = uses.find(({ path }) => path === labelPrefix(node.settings.label));
      return use === undefined ? [] : [[node.settings.libraryId, use] as const];
    }),
  );
  return (libraryId) => {
    const use = byId.get(libraryId);
    return use && { name: use.name, kind: use.kind, sessions: [], uses: [] };
  };
};

type BuildCardRun = {
  run: { id: string; status: SnapshotStatus } | null;
};

type KeptBuild = { buildId: string } & KeptAfterDelete;

export type StageSelection = { nodeId: string; round?: number };

type DeleteQuestion =
  | { kind: "build"; id: string }
  | { kind: "pending"; id: string }
  | { kind: "run"; id: string; from: "runs" | "run-page" };

export type ConfirmingDelete =
  | (Exclude<DeleteQuestion, { kind: "run" }> & { preview: DeletePreview })
  | Extract<DeleteQuestion, { kind: "run" }>;

export const losesWork = (question: ConfirmingDelete): boolean =>
  question.kind !== "run" && (question.preview.dirtyWorktree || question.preview.unpushedBranch);

type DeleteWorktree = { path: string; branch: string; losesWork: boolean };

export const selectDeleteWorktrees = (question: ConfirmingDelete): DeleteWorktree[] =>
  question.kind === "run"
    ? []
    : (question.preview.worktrees ?? []).map(({ path, branch, dirtyWorktree, unpushedBranch }) => ({
        path,
        branch,
        losesWork: dirtyWorktree || unpushedBranch,
      }));

export type StartedSession = { container: string; tmuxName: string };

const containerStatuses = [
  "waiting",
  "not-started",
  "running",
  "done",
  "stopped",
  "failed",
] as const satisfies readonly ContainerStatus[];

const pipelineGroupsSchema: z.ZodType<PipelineGroup[]> = z.array(
  z.object({
    name: z.string(),
    status: z.enum(containerStatuses),
    items: z.array(pipelineItemSchema),
  }),
);

const startedSessionsSchema = z.object({
  runId: z.string(),
  sessions: z.array(z.object({ container: z.string(), tmuxName: z.string() })),
});

export type RunState = {
  snapshots: Record<string, RunSnapshot>;
  latestRunId: string | null;
  starting: boolean;
  error: string | null;
  problems: Problem[] | null;
  buildDialog: BuildDialog | null;
  dialog: RunDialog | null;
  kept: KeptBuild[] | null;
  cost: { runId: string; report: CostReport } | null;
  pipelines: Record<string, PipelineGroup[]>;
  startedSessions: Record<string, StartedSession[]>;
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
  watchCost(runId: string): () => void;
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

export type RunView = {
  snapshot: RunSnapshot | null;
  pipeline?: readonly PipelineGroup[] | null;
};

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
  if (run.starting) return true;
  if (card.run === null) return false;
  const status = run.snapshots[card.run.id]?.status ?? card.run.status;
  return blockingStatuses.includes(status);
};

export const selectExistingBranches = (run: Pick<RunState, "buildDialog">): ExistingBranch[] => {
  const dialog = run.buildDialog;
  if (dialog === null) return [];
  return dialog.branches.map((name) => {
    const path = dialog.checkedOut[name];
    return { name, reason: path === undefined ? null : `Checked out in ${path}` };
  });
};

const oneSessionTarget: BuildTarget = {
  repoOverride: true,
  existingBranch: true,
  branch: true,
  sessions: [],
};

const chosenBranch = (dialog: BuildDialog): RequestBranch | null => {
  if (dialog.branchMode === "new" || !dialog.target.existingBranch) {
    const name = dialog.branchName;
    const base = dialog.target.repoOverride ? dialog.base : "";
    return isValidBranchName(name) ? { mode: "new", name, base } : null;
  }
  const name = dialog.existingBranch;
  const free = name !== null && dialog.branches.includes(name) && !(name in dialog.checkedOut);
  return free ? { mode: "existing", name } : null;
};

const emptyTextValues = ({ variables, values }: BuildDialog): string[] =>
  variables
    .filter(({ kind, name }) => kind === "text" && (values[name] ?? "") === "")
    .map(({ name }) => name);

export const selectBuildRefusal = (run: Pick<RunState, "buildDialog">): string | null => {
  if (run.buildDialog?.problem != null) return run.buildDialog.problem;
  const empty = run.buildDialog === null ? [] : emptyTextValues(run.buildDialog);
  return empty.length === 0 ? null : `Give a value for ${empty.join(", ")}`;
};

export const selectCanBuild = (run: Pick<RunState, "buildDialog">): boolean => {
  const dialog = run.buildDialog;
  if (dialog === null) return false;
  const { repoOverride } = dialog.target;
  return (
    dialog.problem === null &&
    dialog.name.trim() !== "" &&
    (!repoOverride || dialog.repo !== "") &&
    (!repoOverride || dialog.branchMode === "existing" || dialog.base !== "") &&
    (!dialog.target.branch || chosenBranch(dialog) !== null) &&
    emptyTextValues(dialog).length === 0
  );
};

const holdsNode = (items: readonly PipelineItem[], nodeId: string): boolean =>
  items.some((item) =>
    "lanes" in item
      ? item.lanes.some((lane) => holdsNode(lane, nodeId))
      : item.nodeId === nodeId ||
        (item.rounds ?? []).some((round) => holdsNode(round.items, nodeId)),
  );

const sessionStarted = (pipeline: RunView["pipeline"], nodeId: string): boolean =>
  pipeline?.find((group) => holdsNode(group.items, nodeId))?.status !== "not-started";

export const selectNodeDisplay = (run: RunView, nodeId: string): DisplayStatus | null => {
  const { snapshot } = run;
  const state = snapshot?.nodes[nodeId];
  if (snapshot === null || state === undefined) return null;
  return displayStatus(state, snapshot.status, { started: sessionStarted(run.pipeline, nodeId) });
};

export const selectSessionFailure = (
  run: Pick<RunState, "pipelines">,
  runId: string,
): string | null => {
  const failure = sessionFailureOf(run.pipelines[runId] ?? []);
  return failure === undefined ? null : `Failed in ${failure.container}: ${failure.node}`;
};

const noSessions: StartedSession[] = [];

export const selectStartedSessions = (
  run: Pick<RunState, "startedSessions">,
  runId: string,
): StartedSession[] => run.startedSessions[runId] ?? noSessions;

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
  const { snapshot } = run;
  if (snapshot === null) return "Idle";
  const shown = Object.entries(snapshot.nodes)
    .filter(([nodeId]) => sessionStarted(run.pipeline, nodeId))
    .map(([, state]) => displayStatus(state, snapshot.status));
  const done = shown.filter((status) => status === "done").length;
  return `${summaryLabel(snapshot.status, shown, waiting)} · ${done} of ${shown.length} nodes done`;
};

export const selectSessionStatus = (run: RunView, waiting = false): string => {
  const { snapshot } = run;
  if (snapshot === null) return "idle";
  const needsYou = Object.values(snapshot.nodes).some((state) => state === "needs-you");
  return snapshot.status === "running" && (waiting || needsYou) ? "needs you" : snapshot.status;
};

export const selectLiveBadge = (snapshot: RunSnapshot | null): string | null => {
  if (snapshot?.status !== "running") return null;
  const shown = Object.values(snapshot.nodes).map((state) => displayStatus(state, snapshot.status));
  if (shown.includes("needs you")) return "needs you";
  return `running · ${shown.filter((status) => status === "done").length} of ${shown.length}`;
};

export const needsSessionSetup = (problems: readonly Problem[] | null): boolean =>
  problems?.some(
    ({ container, node, field }) =>
      container !== undefined && node === undefined && field !== undefined,
  ) ?? false;

const branchKeptBecause = {
  commits: "holds commits, so it was kept.",
  "open-pr": "was kept: an open pull request uses it.",
  "pr-unknown": "was kept: its pull request status could not be checked.",
  "remote-delete-failed": "on GitHub could not be deleted.",
} as const;

const branchNote = ({ branch, reason, remotes }: Extract<KeptBuild, { kind: "branch" }>) =>
  reason === "remote-moved"
    ? `${branch} on ${(remotes ?? []).join(", ")} has work this build didn't make, so it was kept.`
    : `${branch} ${branchKeptBecause[reason ?? "commits"]}`;

export const selectKeptNote = (kept: KeptBuild): string => {
  switch (kept.kind) {
    case "worktree":
      return `The build is deleted. Its worktree held work, so it was kept at ${kept.path}`;
    case "branch":
      return `The build is deleted. Its branch ${branchNote(kept)}`;
    case "folder":
      return `The build is deleted. Its folder ${kept.path} is outside FLOWDECK_HOME, so it was left in place.`;
  }
};

export const selectKeptNotes = ({ kept }: Pick<RunState, "kept">): string[] =>
  (kept ?? []).map(selectKeptNote);

const defaults = (variables: readonly FoundVariable[]): Record<string, string | boolean> =>
  Object.fromEntries(
    variables.flatMap(({ name, kind }) => (kind === "yes-no" ? [[name, false]] : [])),
  );

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

const without = <T>(record: Record<string, T>, key: string): Record<string, T> =>
  Object.fromEntries(Object.entries(record).filter(([kept]) => kept !== key));

type Every = (ms: number, fn: () => void) => () => void;

const everyInterval: Every = (ms, fn) => {
  const timer = setInterval(fn, ms);
  return () => clearInterval(timer);
};

const LIVE_COST_MS = 2000;

export const createRunStore = ({
  bridge,
  save,
  canvas,
  every = everyInterval,
}: {
  bridge: RunBridge;
  save: StoreApi<SaveState>;
  canvas: StoreApi<CanvasState>;
  every?: Every;
}): StoreApi<RunState> =>
  createStore<RunState>()((set, get) => {
    const costWatches = new Map<string, { watchers: number; cancel: () => void }>();

    const saveFirst = (): Promise<boolean> => {
      const saver = save.getState();
      if (selectDirty(canvas.getState())) return saver.save();
      if (!saver.hasSavedVersion) return saver.save({ force: true });
      return Promise.resolve(true);
    };

    const savedSource = async (): Promise<BuildSource | null> => {
      if (!(await saveFirst())) {
        const { saveCancelled, error } = save.getState();
        if (!saveCancelled) set({ error: error ?? "The blueprint could not be saved" });
        return null;
      }
      const { flowId, version } = save.getState();
      if (flowId === null || version === null) {
        set({ error: "Save the blueprint before building it" });
        return null;
      }
      const { flow } = canvas.getState();
      const source = { flowId, version, buildConfig: sessionFolder(flow) };
      const answer = expandAnswerSchema.safeParse(await bridge.expandFlow({ flow }));
      if (!answer.success) {
        return { ...source, variables: foundVariables(flow), problem: unexpandable };
      }
      if ("problem" in answer.data) {
        return { ...source, variables: foundVariables(flow), problem: answer.data.problem };
      }
      const { flow: expanded, uses } = answer.data;
      return { ...source, variables: groupVariables(foundVariables(expanded), uses) };
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

    const expandedOrSaved = async (
      flow: Flow,
    ): Promise<{ flow: Flow; uses: readonly LibraryUse[] }> => {
      const answer = expandAnswerSchema.safeParse(await bridge.expandFlow({ flow }));
      return answer.success && "flow" in answer.data ? answer.data : { flow, uses: [] };
    };

    const openedVersion = async (
      flowId: string,
    ): Promise<{
      ignored: IgnoredNode[];
      buildModel: string;
      target: BuildTarget;
      buildConfig: BuildConfig | null;
    }> => {
      const flow = openedFlowSchema.nullable().parse(await bridge.openFlow({ flowId }))?.flow;
      const expanded = flow ? await expandedOrSaved(flow) : undefined;
      const main =
        flow && expanded ? mainFlow(flow, usedLibraries(flow, expanded.uses)) : undefined;
      return {
        ignored: (main?.ignored ?? []).map((node) => ({ id: node.id, label: labelFor(node) })),
        buildModel: flow?.settings.buildModel ?? "",
        target: expanded ? buildTarget(expanded.flow) : oneSessionTarget,
        buildConfig: expanded ? sessionFolder(expanded.flow) : null,
      };
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
      if (choices.data.kind === "error") return { ok: false, error: choices.data.message };
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
      startedSessions: {},
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
        bridge.onRunSessions((value) => {
          const parsed = startedSessionsSchema.safeParse(value);
          if (!parsed.success) return;
          const { runId, sessions } = parsed.data;
          set({ startedSessions: { ...get().startedSessions, [runId]: sessions } });
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
        const { flowId, version, variables, problem = null } = opened;
        const { ignored, buildModel, target, buildConfig } = await openedVersion(flowId);
        const prefill = buildConfig ?? opened.buildConfig;
        const repo = prefill.repo ?? "";
        const [base, { branches, checkedOut }] = await Promise.all([
          startingBase(prefill),
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
            variables,
            values: defaults(variables),
            buildModel,
            branches,
            checkedOut,
            branchMode: "new",
            branchName: recommendedBranch("", branches),
            branchNameEdited: false,
            existingBranch: null,
            ignored,
            target,
            step: "form",
            error: null,
            problem,
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
        void startingBase({ repo })
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
        const branch = dialog.target.branch ? chosenBranch(dialog) : undefined;
        if (branch === null) return null;
        if (dialog.step === "form" && dialog.ignored.length > 0) {
          set({ buildDialog: { ...dialog, step: "confirm", error: null } });
          return null;
        }
        const { flowId, version, name, values, target } = dialog;
        const repo = target.repoOverride ? dialog.repo : "";
        const base = target.repoOverride ? dialog.base : "";
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
            ...(repo === "" ? {} : { repo }),
            ...(base === "" ? {} : { base }),
            ...(branch === undefined ? {} : { branch }),
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
            kept: result.kept?.map((kept) => ({ buildId, ...kept })) ?? null,
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
          const pipeline = pipelineGroupsSchema.parse(await bridge.runPipeline({ runId }));
          set({ pipelines: { ...get().pipelines, [runId]: pipeline } });
        } catch (thrown) {
          set({ error: messageOf(thrown) });
        }
      },

      watchCost: (runId) => {
        const watch = costWatches.get(runId) ?? {
          watchers: 0,
          cancel: every(LIVE_COST_MS, () => {
            void get().loadPipeline(runId);
            void get().loadCost(runId);
          }),
        };
        watch.watchers += 1;
        costWatches.set(runId, watch);
        let stopped = false;
        return () => {
          if (stopped) return;
          stopped = true;
          watch.watchers -= 1;
          if (watch.watchers > 0) return;
          watch.cancel();
          costWatches.delete(runId);
        };
      },

      selectStage: (runId, stage) =>
        set({ selectedStage: { ...get().selectedStage, [runId]: stage } }),

      openMenu: (key) => set({ menuOpen: key }),

      closeMenu: () => set({ menuOpen: null }),

      askDelete: async (question) => {
        if (question.kind === "run") {
          set({ confirmingDelete: question });
          return;
        }
        try {
          const preview = deletePreviewSchema.parse(
            question.kind === "build"
              ? await bridge.deletePreview({ buildId: question.id })
              : await bridge.deletePendingPreview({ id: question.id }),
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
