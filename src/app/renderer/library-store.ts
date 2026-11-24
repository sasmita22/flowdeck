import { z } from "zod";
import { createStore, type StoreApi } from "zustand/vanilla";
import { doctorReportSchema, type DoctorReport } from "../../core/doctor/connectors.js";
import { flowSummarySchema, type FlowSummary } from "../../core/flow/flow-store.js";
import {
  buildEntriesSchema,
  buildFileContentSchema,
  buildPictureSchema,
  buildProjectSchema,
  buildRecordSchema,
  buildTreeSchema,
  loadedRunSchema,
  pendingBuildTreeSchema,
  runSummarySchema,
  type BuildEntry,
  type BuildFileContent,
  type BuildProject,
  type BuildTree,
  type LoadedRun,
} from "../../core/run/listing.js";
import type { SnapshotKey } from "../../core/run/store.js";
import type { FlowdeckBridge } from "../preload/bridge.js";

export type LibraryBridge = Pick<
  FlowdeckBridge,
  | "listFlows"
  | "listBuilds"
  | "listRuns"
  | "renameFlow"
  | "pinFlow"
  | "deleteFlow"
  | "buildFiles"
  | "buildPicture"
  | "buildTree"
  | "buildProject"
  | "buildEntries"
  | "pendingBuildTree"
  | "doctor"
  | "loadRun"
  | "doctorWorktrees"
>;

type BuildRecord = z.infer<typeof buildRecordSchema>;
type RunSummary = z.infer<typeof runSummarySchema>;

export type DeleteQuestion = Pick<FlowSummary, "flowId" | "name">;

export const blueprintKindLabel: Record<FlowSummary["kind"], string> = {
  workflow: "Workflow",
  "node-library": "Node library",
  "session-library": "Session library",
  incomplete: "Incomplete",
};

export type BuildFiles = { buildId: string; list: BuildFileContent[]; selected: string | null };

export type OpenTree = BuildTree & { buildId: string };

export type OpenProject = BuildProject & { buildId: string };

export type LibraryState = {
  flows: FlowSummary[];
  builds: BuildRecord[];
  runs: RunSummary[];
  loaded: boolean;
  error: string | null;
  files: BuildFiles | null;
  tree: OpenTree | null;
  project: OpenProject | null;
  projectEntries: Record<string, BuildEntry[]>;
  pendingTrees: Record<string, string[] | null>;
  doctor: DoctorReport | null;
  worktrees: string[] | null;
  viewedRun: LoadedRun | null;
  pictures: Record<string, string | null>;
  confirmingDelete: DeleteQuestion | null;
  refresh(): Promise<void>;
  openRun(runId: string): Promise<void>;
  rename(flowId: string, name: string): Promise<boolean>;
  pin(flowId: string, pinned: boolean): Promise<void>;
  askDelete(flow: DeleteQuestion): void;
  cancelDelete(): void;
  delete(flowId: string): Promise<boolean>;
  openFiles(buildId: string): Promise<void>;
  selectFile(path: string): void;
  expandProjectFolder(path: string): Promise<void>;
  loadPendingTree(pendingId: string): Promise<void>;
  loadPicture(key: SnapshotKey): Promise<void>;
  diagnose(): Promise<void>;
  listWorktrees(): Promise<void>;
};

export type BuildCard = {
  id: string;
  name: string;
  blueprint: string;
  version: number | null;
  createdAt: number;
  flowId: string | null;
  old: boolean;
  run: Pick<RunSummary, "id" | "status"> | null;
};

export type RunCard = RunSummary & { name: string; version: number | null };

const pictureKey = (key: SnapshotKey) =>
  "buildId" in key ? `build:${key.buildId}` : `pending:${key.pendingId}`;

export const selectPicture = (
  state: Pick<LibraryState, "pictures">,
  key: SnapshotKey,
): string | null | undefined => state.pictures[pictureKey(key)];

const latestRun = (runs: readonly RunSummary[], buildId: string) => {
  const run = runs.find((listed) => listed.buildId === buildId);
  return run === undefined ? null : { id: run.id, status: run.status };
};

export const selectBuildCards = (state: Pick<LibraryState, "builds" | "runs">): BuildCard[] =>
  state.builds.map((build) => ({
    id: build.id,
    name: build.name ?? build.blueprintName ?? build.id,
    blueprint: build.blueprintName ?? "",
    version: build.blueprintVersion,
    createdAt: build.createdAt,
    flowId: build.source?.flowId ?? null,
    old: build.old,
    run: latestRun(state.runs, build.id),
  }));

export const selectRunCards = (state: Pick<LibraryState, "runs">): RunCard[] =>
  state.runs.map((run) => ({
    ...run,
    name: run.buildName ?? run.blueprintName ?? run.buildId ?? run.id,
    version: run.blueprintVersion,
  }));

export type RunBuildOption = { buildId: string; label: string };

export const selectRunBuildOptions = (runs: readonly RunSummary[]): RunBuildOption[] => {
  const options = new Map<string, RunBuildOption>();
  for (const run of runs) {
    if (run.buildId === undefined || options.has(run.buildId)) continue;
    options.set(run.buildId, { buildId: run.buildId, label: run.buildName ?? run.buildId });
  }
  return [...options.values()];
};

export const filterRunsByBuild = <T extends Pick<RunSummary, "buildId">>(
  cards: readonly T[],
  buildId: string | undefined,
): T[] => (buildId === undefined ? [...cards] : cards.filter((card) => card.buildId === buildId));

export const pinnedFirst = <T extends Pick<FlowSummary, "pinned">>(flows: readonly T[]): T[] => [
  ...flows.filter((flow) => flow.pinned),
  ...flows.filter((flow) => !flow.pinned),
];

const manifestFirst = (a: BuildFileContent, b: BuildFileContent) =>
  Number(b.path === "manifest.json") - Number(a.path === "manifest.json") ||
  a.path.localeCompare(b.path);

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export const createLibraryStore = ({ bridge }: { bridge: LibraryBridge }): StoreApi<LibraryState> =>
  createStore<LibraryState>()((set, get) => ({
    flows: [],
    builds: [],
    runs: [],
    loaded: false,
    error: null,
    files: null,
    tree: null,
    project: null,
    projectEntries: {},
    pendingTrees: {},
    doctor: null,
    worktrees: null,
    viewedRun: null,
    pictures: {},
    confirmingDelete: null,

    openRun: async (runId) => {
      try {
        set({ viewedRun: loadedRunSchema.parse(await bridge.loadRun({ runId })), error: null });
      } catch (error) {
        set({ viewedRun: null, error: messageOf(error) });
      }
    },

    refresh: async () => {
      try {
        const [flows, builds, runs] = await Promise.all([
          bridge.listFlows(),
          bridge.listBuilds(),
          bridge.listRuns(),
        ]);
        set({
          flows: z.array(flowSummarySchema).parse(flows),
          builds: z.array(buildRecordSchema).parse(builds),
          runs: z.array(runSummarySchema).parse(runs),
          loaded: true,
          error: null,
        });
      } catch (error) {
        set({ error: messageOf(error) });
      }
    },

    rename: async (flowId, name) => {
      try {
        await bridge.renameFlow({ flowId, name });
      } catch (error) {
        set({ error: messageOf(error) });
        return false;
      }
      await get().refresh();
      return true;
    },

    pin: async (flowId, pinned) => {
      try {
        await bridge.pinFlow({ flowId, pinned });
      } catch (error) {
        set({ error: messageOf(error) });
        return;
      }
      await get().refresh();
    },

    askDelete: ({ flowId, name }) => set({ confirmingDelete: { flowId, name } }),

    cancelDelete: () => set({ confirmingDelete: null }),

    delete: async (flowId) => {
      try {
        await bridge.deleteFlow({ flowId });
      } catch (error) {
        set({ confirmingDelete: null, error: messageOf(error) });
        return false;
      }
      set({ confirmingDelete: null });
      await get().refresh();
      return true;
    },

    openFiles: async (buildId) => {
      set({
        files: { buildId, list: [], selected: null },
        tree: null,
        project: null,
        projectEntries: {},
      });
      const stillOpen = () => get().files?.buildId === buildId;
      try {
        const tree = buildTreeSchema.parse(await bridge.buildTree({ buildId }));
        if (!stillOpen()) return;
        set({ tree: { buildId, ...tree }, error: null });
        const [files, answer] = await Promise.all([
          bridge.buildFiles({ buildId }),
          bridge.buildProject({ buildId }),
        ]);
        if (!stillOpen()) return;
        const list = z.array(buildFileContentSchema).parse(files).sort(manifestFirst);
        const project = buildProjectSchema.nullable().parse(answer);
        set({
          files: { buildId, list, selected: list[0]?.path ?? null },
          project: project === null ? null : { buildId, ...project },
          error: null,
        });
      } catch (error) {
        set({ error: messageOf(error) });
      }
    },

    expandProjectFolder: async (path) => {
      const { files, projectEntries } = get();
      if (files === null || path in projectEntries) return;
      const { buildId } = files;
      try {
        const entries = buildEntriesSchema.parse(await bridge.buildEntries({ buildId, path }));
        if (get().files?.buildId !== buildId) return;
        set((state) => ({
          projectEntries: { ...state.projectEntries, [path]: entries },
          error: null,
        }));
      } catch (error) {
        set({ error: messageOf(error) });
      }
    },

    loadPendingTree: async (pendingId) => {
      try {
        const tree = pendingBuildTreeSchema
          .nullable()
          .parse(await bridge.pendingBuildTree({ pendingId }));
        set((state) => ({
          pendingTrees: { ...state.pendingTrees, [pendingId]: tree?.paths ?? null },
          error: null,
        }));
      } catch (error) {
        set({ error: messageOf(error) });
      }
    },

    loadPicture: async (key) => {
      try {
        const { svg } = buildPictureSchema.parse(await bridge.buildPicture(key));
        set((state) => ({ pictures: { ...state.pictures, [pictureKey(key)]: svg }, error: null }));
      } catch (error) {
        set({ error: messageOf(error) });
      }
    },

    selectFile: (path) => {
      const { files } = get();
      if (files !== null) set({ files: { ...files, selected: path } });
    },

    diagnose: async () => {
      try {
        set({ doctor: doctorReportSchema.parse(await bridge.doctor()), error: null });
      } catch (error) {
        set({ error: messageOf(error) });
      }
    },

    listWorktrees: async () => {
      try {
        set({ worktrees: z.array(z.string()).parse(await bridge.doctorWorktrees()), error: null });
      } catch (error) {
        set({ error: messageOf(error) });
      }
    },
  }));
