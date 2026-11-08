import { z } from "zod";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { BuildAnswer } from "../../core/compiler/build-report.js";
import { activityEntrySchema, type ActivityEntry } from "../../core/run/activity.js";
import {
  buildProgressEntrySchema,
  nodeAuditStatus,
  type BuildProgress,
  type BuildProgressEntry,
  type ComponentStatus,
} from "../../core/run/build-progress.js";
import { buildVersionResultSchema } from "../../core/run/listing.js";
import type { FlowdeckBridge } from "../preload/bridge.js";

export type BuildProgressBridge = Pick<
  FlowdeckBridge,
  | "listBuildProgress"
  | "onBuildProgress"
  | "stopBuild"
  | "getBuildActivity"
  | "onBuildActivity"
  | "buildRebuild"
>;

const activityPushSchema = z.object({ pendingId: z.string(), entry: activityEntrySchema });

const withEntry = (entries: readonly ActivityEntry[], entry: ActivityEntry): ActivityEntry[] =>
  [...entries.filter((kept) => kept.id !== entry.id), entry].sort((a, b) => a.id - b.id);

export type BuildProgressState = {
  entries: Record<string, BuildProgressEntry>;
  activity: Record<string, ActivityEntry[]>;
  drafts: Record<string, Record<number, string>>;
  rebuilding: Record<string, boolean>;
  rebuildErrors: Record<string, string>;
  connect(): Promise<void>;
  viewActivity(pendingId: string): Promise<void>;
  activityFor(pendingId: string): ActivityEntry[];
  chipFor(flowId: string): string | undefined;
  barFor(flowId: string): { pendingId: string; chip: string } | undefined;
  progressFor(pendingId: string): BuildProgress | undefined;
  isBuilding(flowId: string): boolean;
  nodeAuditStatus(flowId: string, nodeId: string): ComponentStatus | undefined;
  stop(pendingId: string): Promise<void>;
  setAnswer(pendingId: string, index: number, text: string): void;
  answerFor(pendingId: string, index: number): string;
  canRebuild(pendingId: string): boolean;
  isRebuilding(pendingId: string): boolean;
  rebuildErrorFor(pendingId: string): string | undefined;
  rebuild(pendingId: string): Promise<void>;
};

const noActivity: ActivityEntry[] = [];

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

const without = <T>(record: Record<string, T>, key: string): Record<string, T> =>
  Object.fromEntries(Object.entries(record).filter(([kept]) => kept !== key));

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

    const answersFor = (pendingId: string): BuildAnswer[] | undefined => {
      const questions = get().entries[pendingId]?.progress.questions ?? [];
      const answers = questions.map((question, index) => ({
        ...question,
        answer: get().answerFor(pendingId, index).trim(),
      }));
      return answers.length > 0 && answers.every(({ answer }) => answer !== "")
        ? answers
        : undefined;
    };

    const endRebuild = (pendingId: string, error?: string) => {
      const { drafts, rebuilding, rebuildErrors } = get();
      set({
        rebuilding: without(rebuilding, pendingId),
        ...(error === undefined
          ? { drafts: without(drafts, pendingId), rebuildErrors: without(rebuildErrors, pendingId) }
          : { rebuildErrors: { ...rebuildErrors, [pendingId]: error } }),
      });
    };

    return {
      entries: {},
      activity: {},
      drafts: {},
      rebuilding: {},
      rebuildErrors: {},

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

      setAnswer: (pendingId, index, text) => {
        const { drafts } = get();
        set({ drafts: { ...drafts, [pendingId]: { ...drafts[pendingId], [index]: text } } });
      },
      answerFor: (pendingId, index) => get().drafts[pendingId]?.[index] ?? "",
      canRebuild: (pendingId) =>
        !get().isRebuilding(pendingId) && answersFor(pendingId) !== undefined,
      isRebuilding: (pendingId) => get().rebuilding[pendingId] === true,
      rebuildErrorFor: (pendingId) => get().rebuildErrors[pendingId],
      rebuild: async (pendingId) => {
        const answers = answersFor(pendingId);
        if (answers === undefined || get().isRebuilding(pendingId)) return;
        set({ rebuilding: { ...get().rebuilding, [pendingId]: true } });
        let answer: unknown;
        try {
          answer = await bridge.buildRebuild({ pendingId, answers });
        } catch (thrown) {
          endRebuild(pendingId, messageOf(thrown));
          return;
        }
        const result = buildVersionResultSchema.safeParse(answer);
        if (!result.success) endRebuild(pendingId, "unexpected build result");
        else if (result.data.kind === "error") endRebuild(pendingId, result.data.message);
        else endRebuild(pendingId);
      },
    };
  });
