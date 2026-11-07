import { z } from "zod";
import { createStore, type StoreApi } from "zustand/vanilla";
import { activityEntrySchema, type ActivityEntry } from "../../core/run/activity.js";
import {
  buildProgressEntrySchema,
  nodeAuditStatus,
  type BuildProgress,
  type BuildProgressEntry,
  type ComponentStatus,
} from "../../core/run/build-progress.js";
import type { FlowdeckBridge } from "../preload/bridge.js";

export type BuildProgressBridge = Pick<
  FlowdeckBridge,
  "listBuildProgress" | "onBuildProgress" | "stopBuild" | "getBuildActivity" | "onBuildActivity"
>;

const activityPushSchema = z.object({ pendingId: z.string(), entry: activityEntrySchema });

const withEntry = (entries: readonly ActivityEntry[], entry: ActivityEntry): ActivityEntry[] =>
  [...entries.filter((kept) => kept.id !== entry.id), entry].sort((a, b) => a.id - b.id);

export type BuildProgressState = {
  entries: Record<string, BuildProgressEntry>;
  activity: Record<string, ActivityEntry[]>;
  connect(): Promise<void>;
  viewActivity(pendingId: string): Promise<void>;
  activityFor(pendingId: string): ActivityEntry[];
  chipFor(flowId: string): string | undefined;
  barFor(flowId: string): { pendingId: string; chip: string } | undefined;
  progressFor(pendingId: string): BuildProgress | undefined;
  isBuilding(flowId: string): boolean;
  nodeAuditStatus(flowId: string, nodeId: string): ComponentStatus | undefined;
  stop(pendingId: string): Promise<void>;
};

const noActivity: ActivityEntry[] = [];

const isOpen = (entry: BuildProgressEntry) => entry.progress.outcomeLabel === undefined;

export const createBuildProgressStore = (
  bridge: BuildProgressBridge,
): StoreApi<BuildProgressState> =>
  createStore<BuildProgressState>()((set, get) => {
    const put = (entry: BuildProgressEntry) =>
      set({ entries: { ...get().entries, [entry.pendingId]: entry } });

    const currentFor = (flowId: string): BuildProgressEntry | undefined => {
      const own = Object.values(get().entries).filter((entry) => entry.flowId === flowId);
      return own.find(isOpen) ?? own.at(-1);
    };

    const putActivity = (pendingId: string, entry: ActivityEntry) => {
      const { activity } = get();
      set({ activity: { ...activity, [pendingId]: withEntry(activity[pendingId] ?? [], entry) } });
    };

    return {
      entries: {},
      activity: {},

      connect: async () => {
        bridge.onBuildProgress((value) => {
          const parsed = buildProgressEntrySchema.safeParse(value);
          if (parsed.success) put(parsed.data);
        });
        bridge.onBuildActivity((value) => {
          const parsed = activityPushSchema.safeParse(value);
          if (parsed.success) putActivity(parsed.data.pendingId, parsed.data.entry);
        });
        const listed = z
          .array(buildProgressEntrySchema)
          .safeParse(await bridge.listBuildProgress());
        if (listed.success) listed.data.forEach(put);
      },

      viewActivity: async (pendingId) => {
        const fetched = z
          .array(activityEntrySchema)
          .safeParse(await bridge.getBuildActivity({ pendingId }));
        if (!fetched.success) return;
        const pushed = new Set((get().activity[pendingId] ?? []).map((entry) => entry.id));
        fetched.data
          .filter((entry) => !pushed.has(entry.id))
          .forEach((entry) => putActivity(pendingId, entry));
      },

      activityFor: (pendingId) => get().activity[pendingId] ?? noActivity,

      chipFor: (flowId) => currentFor(flowId)?.progress.chip,
      barFor: (flowId) => {
        const entry = currentFor(flowId);
        return entry === undefined
          ? undefined
          : { pendingId: entry.pendingId, chip: entry.progress.chip };
      },
      progressFor: (pendingId) => get().entries[pendingId]?.progress,
      isBuilding: (flowId) => {
        const entry = currentFor(flowId);
        return entry !== undefined && isOpen(entry);
      },
      nodeAuditStatus: (flowId, nodeId) => {
        const entry = currentFor(flowId);
        return entry === undefined ? undefined : nodeAuditStatus(entry.progress, nodeId);
      },
      stop: async (pendingId) => {
        await bridge.stopBuild({ pendingId });
      },
    };
  });
