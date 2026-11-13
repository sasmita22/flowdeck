import { z } from "zod";
import { createStore, type StoreApi } from "zustand/vanilla";
import { doctorReportSchema, type DoctorReport } from "../../core/doctor/connectors.js";
import {
  flowSummarySchema,
  openedFlowSchema,
  type FlowSummary,
} from "../../core/flow/flow-store.js";
import {
  buildFileContentSchema,
  buildPictureSchema,
  buildRecordSchema,
  loadedRunSchema,
  runSummarySchema,
  type BuildFileContent,
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
  | "buildFiles"
  | "buildPicture"
  | "openFlow"
  | "doctor"
  | "loadRun"
  | "doctorWorktrees"
>;

type BuildRecord = z.infer<typeof buildRecordSchema>;
type RunSummary = z.infer<typeof runSummarySchema>;

export type BuildFiles = { buildId: string; list: BuildFileContent[]; selected: string | null };

export type LibraryState = {
  flows: FlowSummary[];
  builds: BuildRecord[];
  runs: RunSummary[];
  loaded: boolean;
  error: string | null;
  files: BuildFiles | null;
  doctor: DoctorReport | null;
  worktrees: string[] | null;
  viewedRun: LoadedRun | null;
  pictures: Record<string, string | null>;
  refresh(): Promise<void>;
  openRun(runId: string): Promise<void>;
  rename(flowId: string, name: string): Promise<boolean>;
  pin(flowId: string, pinned: boolean): Promise<void>;
  openFiles(buildId: string): Promise<void>;
  selectFile(path: string): void;
  loadPicture(key: SnapshotKey): Promise<void>;
  diagnose(flowId: string | null, openConnectors: readonly string[]): Promise<void>;
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
    doctor: null,
    worktrees: null,
    viewedRun: null,
    pictures: {},

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

    openFiles: async (buildId) => {
      set({ files: { buildId, list: [], selected: null } });
      try {
        const list = z
          .array(buildFileContentSchema)
          .parse(await bridge.buildFiles({ buildId }))
          .sort(manifestFirst);
        set({ files: { buildId, list, selected: list[0]?.path ?? null }, error: null });
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

    diagnose: async (flowId, openConnectors) => {
      try {
        const connectors =
          flowId === null
            ? [...openConnectors]
            : (openedFlowSchema.parse(await bridge.openFlow({ flowId })).flow?.session.connectors ??
              []);
        set({ doctor: doctorReportSchema.parse(await bridge.doctor({ connectors })), error: null });
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
