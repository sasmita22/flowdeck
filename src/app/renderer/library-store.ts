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
  buildRecordSchema,
  loadedRunSchema,
  runSummarySchema,
  type BuildFileContent,
  type LoadedRun,
} from "../../core/run/listing.js";
import type { FlowdeckBridge } from "../preload/bridge.js";

export type LibraryBridge = Pick<
  FlowdeckBridge,
  | "listFlows"
  | "listBuilds"
  | "listRuns"
  | "renameFlow"
  | "buildFiles"
  | "openFlow"
  | "doctor"
  | "loadRun"
>;

type BuildRecord = z.infer<typeof buildRecordSchema>;
type RunSummary = z.infer<typeof runSummarySchema>;

export type BuildFiles = { hash: string; list: BuildFileContent[]; selected: string | null };

export type LibraryState = {
  flows: FlowSummary[];
  builds: BuildRecord[];
  runs: RunSummary[];
  loaded: boolean;
  error: string | null;
  files: BuildFiles | null;
  doctor: DoctorReport | null;
  viewedRun: LoadedRun | null;
  refresh(): Promise<void>;
  openRun(runId: string): Promise<void>;
  rename(flowId: string, name: string): Promise<boolean>;
  openFiles(hash: string): Promise<void>;
  selectFile(path: string): void;
  diagnose(flowId: string | null, openConnectors: readonly string[]): Promise<void>;
};

export const noBlueprint = "Not from a blueprint";

export type BuildCard = {
  hash: string;
  name: string;
  version: number | null;
  createdAt: number;
  flowId: string | null;
};

export type RunCard = RunSummary & { name: string; version: number | null };

const nameIn = (flows: readonly FlowSummary[], flowId: string | undefined) =>
  flows.find((flow) => flow.flowId === flowId)?.name ?? noBlueprint;

export const selectBuildCards = (state: Pick<LibraryState, "flows" | "builds">): BuildCard[] =>
  state.builds.map((build) => ({
    hash: build.hash,
    name: nameIn(state.flows, build.source?.flowId),
    version: build.source?.version ?? null,
    createdAt: build.createdAt,
    flowId: build.source?.flowId ?? null,
  }));

export const selectRunCards = (state: Pick<LibraryState, "flows" | "runs">): RunCard[] =>
  state.runs.map((run) => ({
    ...run,
    name: nameIn(state.flows, run.source?.flowId),
    version: run.source?.version ?? null,
  }));

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
    viewedRun: null,

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

    openFiles: async (hash) => {
      set({ files: { hash, list: [], selected: null } });
      try {
        const list = z
          .array(buildFileContentSchema)
          .parse(await bridge.buildFiles({ hash }))
          .sort(manifestFirst);
        set({ files: { hash, list, selected: list[0]?.path ?? null }, error: null });
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
  }));
