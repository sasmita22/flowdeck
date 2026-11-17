import { z } from "zod";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { BuildAnswer } from "../../core/compiler/build-report.js";
import { activityEntrySchema, type ActivityEntry } from "../../core/run/activity.js";
import { buildPipelineOf, type BuildPipeline } from "../../core/run/build-pipeline.js";
import {
  buildingCardOf,
  buildProgressEntrySchema,
  type BuildingCard,
  type BuildProgress,
  type BuildProgressEntry,
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
  removed: Record<string, true>;
  connect(): Promise<void>;
  viewActivity(pendingId: string): Promise<void>;
  activityFor(pendingId: string): ActivityEntry[];
  progressFor(pendingId: string): BuildProgress | undefined;
  stop(pendingId: string): Promise<void>;
  setAnswer(pendingId: string, index: number, text: string): void;
  answerFor(pendingId: string, index: number): string;
  canRebuild(pendingId: string): boolean;
  isRebuilding(pendingId: string): boolean;
  rebuildErrorFor(pendingId: string): string | undefined;
  rebuild(pendingId: string): Promise<void>;
  remove(pendingId: string): void;
};

const noActivity: ActivityEntry[] = [];

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

const without = <T>(record: Record<string, T>, key: string): Record<string, T> =>
  Object.fromEntries(Object.entries(record).filter(([kept]) => kept !== key));

const endsLater = (entry: BuildProgressEntry, than: BuildProgressEntry) =>
  (entry.endedAt ?? 0) > (than.endedAt ?? 0) ||
  (entry.endedAt === than.endedAt && entry.startedAt > than.startedAt);

const latestEndedByName = (entries: readonly BuildProgressEntry[]): BuildProgressEntry[] => {
  const latest = new Map<string, BuildProgressEntry>();
  for (const entry of entries) {
    const kept = latest.get(entry.name);
    if (kept === undefined || endsLater(entry, kept)) latest.set(entry.name, entry);
  }
  return [...latest.values()];
};

type Shown = Pick<BuildProgressState, "entries" | "removed">;

const isShown = (state: Shown) => (entry: BuildProgressEntry) => !state.removed[entry.pendingId];

export const selectBuildingCards = (state: Shown): BuildingCard[] => {
  const entries = Object.values(state.entries);
  const open = entries.filter((entry) => entry.outcome === undefined);
  const ended = latestEndedByName(entries.filter((entry) => entry.outcome !== undefined));
  return [...open, ...ended]
    .filter(isShown(state))
    .flatMap((entry) => buildingCardOf(entry) ?? [])
    .sort((a, b) => b.startedAt - a.startedAt);
};

export const selectBuildingCount = (state: Shown): number =>
  Object.values(state.entries)
    .filter(isShown(state))
    .filter((entry) => entry.outcome === undefined).length;

export const selectFlowBuilding =
  (flowId: string) =>
  (state: Pick<BuildProgressState, "entries">): boolean =>
    Object.values(state.entries).some(
      (entry) => entry.flowId === flowId && entry.endedAt === undefined,
    );

export const selectPipeline =
  (pendingId: string) =>
  (state: Pick<BuildProgressState, "entries" | "activity">): BuildPipeline | undefined => {
    const entry = state.entries[pendingId];
    if (entry === undefined) return undefined;
    const { name, startedAt, endedAt, outcome, buildId, events } = entry;
    return buildPipelineOf(
      {
        id: pendingId,
        name,
        startedAt,
        ...(endedAt === undefined ? {} : { endedAt }),
        ...(outcome === undefined ? {} : { outcome }),
        ...(buildId === undefined ? {} : { buildId }),
      },
      events,
      state.activity[pendingId] ?? noActivity,
    );
  };

export const createBuildProgressStore = (
  bridge: BuildProgressBridge,
): StoreApi<BuildProgressState> =>
  createStore<BuildProgressState>()((set, get) => {
    const put = (entry: BuildProgressEntry) =>
      set({ entries: { ...get().entries, [entry.pendingId]: entry } });

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
      removed: {},

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

      progressFor: (pendingId) => get().entries[pendingId]?.progress,
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

      remove: (pendingId) => set({ removed: { ...get().removed, [pendingId]: true } }),
    };
  });
