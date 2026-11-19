import {
  feedOf,
  foldHookEvent,
  previewOf,
  foldNodeEvent,
  type ActivityEntry,
  type ActivityFeed,
  type ActivityHookEvent,
  type FoldResult,
  type WorkingPlace,
} from "../../core/run/activity.js";
import type { AgentCall } from "../../core/run/agent-calls.js";
import { trackWindow, type NodeWindow } from "../../core/run/attribution.js";
import type { TurnEvents } from "../../core/run/turns.js";
import type { BuildStepEvent } from "../../ports/build-agents.js";
import type { EventEntry, Store } from "../../ports/store.js";
import type { EnginePush } from "./protocol.js";

export type ActivityTrackerOptions = {
  runId: string;
  now: () => number;
  publish: (push: EnginePush) => void;
  log: (line: string) => void;
  activity: Pick<Store, "recordActivity" | "activity" | "appendStepText">;
  turnNodes: ReadonlySet<string>;
  place: WorkingPlace;
};

export type ActivityTracker = {
  store(inner: Store): Store;
  watch(events: TurnEvents, sessionId: string): () => void;
};

export function createActivityTracker(options: ActivityTrackerOptions): ActivityTracker {
  const { runId, now, publish, log, activity, turnNodes, place } = options;
  let windows: NodeWindow[] = [];
  let feed: ActivityFeed = feedOf(activity.activity(runId));

  const apply = (fold: (current: ActivityFeed) => FoldResult): void => {
    try {
      const folded = fold(feed);
      feed = folded.feed;
      for (const entry of folded.changed) {
        activity.recordActivity(runId, entry);
        publish({ push: "activity", value: { runId, entry } });
      }
      for (const { entryId, field, text } of folded.cut) {
        activity.appendStepText(runId, entryId, field, text);
      }
    } catch (error) {
      log(error instanceof Error ? error.message : String(error));
    }
  };

  const track = (id: string, entries: readonly EventEntry[]): void => {
    if (id !== runId) return;
    const at = now();
    for (const { nodeId, event } of entries) {
      windows = trackWindow(windows, nodeId, event.kind, at);
      apply((current) => foldNodeEvent(current, { nodeId, at, turnNodes }, event));
    }
  };

  const handlerFor =
    (kind: ActivityHookEvent["kind"]) =>
    ({ payload }: { payload: Record<string, unknown> }): void =>
      apply((current) => foldHookEvent(current, windows, { kind, payload }, place));

  return {
    store: (inner) => ({
      createRun: (run) => inner.createRun(run),
      findRun: (id) => inner.findRun(id),
      events: (id) => inner.events(id),
      finishRun: (id, status) => inner.finishRun(id, status),
      reopenRun: (id) => inner.reopenRun(id),
      stopRun: (id) => inner.stopRun(id),
      recordActivity: (id, entry) => inner.recordActivity(id, entry),
      activity: (id) => inner.activity(id),
      recordCost: (id, totalCost) => inner.recordCost(id, totalCost),
      appendRunStory: (story) => inner.appendRunStory(story),
      latestRunStory: (id) => inner.latestRunStory(id),
      appendRepoState: (id, phase, state, otherRepos) =>
        inner.appendRepoState(id, phase, state, otherRepos),
      repoStates: (id) => inner.repoStates(id),
      appendStepText: (id, entryId, field, text) => inner.appendStepText(id, entryId, field, text),
      stepTexts: (id, entryId) => inner.stepTexts(id, entryId),
      appendOtherRepoBefore: (id, repo, state) => inner.appendOtherRepoBefore(id, repo, state),
      appendBuildStepText: (pendingId, entryId, field, text) =>
        inner.appendBuildStepText(pendingId, entryId, field, text),
      buildStepTexts: (pendingId, entryId) => inner.buildStepTexts(pendingId, entryId),
      recordBuild: (build) => inner.recordBuild(build),
      findBuild: (id) => inner.findBuild(id),
      findBuildByName: (name) => inner.findBuildByName(name),
      deleteBuild: (id) => inner.deleteBuild(id),
      deleteRun: (runId) => inner.deleteRun(runId),
      deletePendingBuild: (id) => inner.deletePendingBuild(id),
      listBuilds: () => inner.listBuilds(),
      addBuildWorktree: (buildId, worktree) => inner.addBuildWorktree(buildId, worktree),
      buildWorktrees: (buildId) => inner.buildWorktrees(buildId),
      listRuns: () => inner.listRuns(),
      findRunSummary: (id) => inner.findRunSummary(id),
      buildFiles: (id) => inner.buildFiles(id),
      startPendingBuild: (build) => inner.startPendingBuild(build),
      appendBuildEvent: (pendingId, event) => inner.appendBuildEvent(pendingId, event),
      buildEvents: (pendingId) => inner.buildEvents(pendingId),
      endPendingBuild: (pendingId, end) => inner.endPendingBuild(pendingId, end),
      listPendingBuilds: () => inner.listPendingBuilds(),
      listLatestEndedPendingBuildsByName: () => inner.listLatestEndedPendingBuildsByName(),
      findPendingBuildByName: (name) => inner.findPendingBuildByName(name),
      pendingBuild: (id) => inner.pendingBuild(id),
      appendBuildActivity: (pendingId, entry) => inner.appendBuildActivity(pendingId, entry),
      buildActivity: (pendingId) => inner.buildActivity(pendingId),
      buildSnapshot: (key) => inner.buildSnapshot(key),
      listSnapshotGaps: () => inner.listSnapshotGaps(),
      addSnapshotIfMissing: (gap, snapshot) => inner.addSnapshotIfMissing(gap, snapshot),
      storeManifest: (manifest) => inner.storeManifest(manifest),
      buildManifest: (buildId) => inner.buildManifest(buildId),
      listManifestGaps: () => inner.listManifestGaps(),
      append(id, nodeId, event) {
        inner.append(id, nodeId, event);
        track(id, [{ nodeId, event }]);
      },
      appendAll(id, entries) {
        inner.appendAll(id, entries);
        track(id, entries);
      },
    }),
    watch(events, sessionId) {
      const unsubscribes = (
        ["PreToolUse", "PostToolUse", "PostToolUseFailure", "SubagentStop"] as const
      ).map((kind) => events.subscribe(kind, sessionId, handlerFor(kind)));
      return () => {
        for (const unsubscribe of unsubscribes) unsubscribe();
      };
    },
  };
}

export type BuildActivityOptions = {
  pendingId: string;
  now: () => number;
  activity: Pick<Store, "appendBuildActivity" | "buildActivity" | "appendBuildStepText">;
  publish: (push: EnginePush) => void;
};

export type BuildActivity = {
  (call: AgentCall, report?: string): void;
  step(event: BuildStepEvent): void;
};

type SubagentEntry = Extract<ActivityEntry, { kind: "subagent" }>;

const latestById = (entries: readonly ActivityEntry[]): ActivityEntry[] => [
  ...new Map(entries.map((entry) => [entry.id, entry])).values(),
];

export function createBuildActivity({
  pendingId,
  now,
  activity,
  publish,
}: BuildActivityOptions): BuildActivity {
  let feed = feedOf(latestById(activity.buildActivity(pendingId)));
  const running = new Map<string, number>();
  const held = new Map<string, BuildStepEvent[]>();

  const save = (entries: readonly ActivityEntry[]) => {
    for (const entry of entries) {
      activity.appendBuildActivity(pendingId, entry);
      publish({ push: "build-activity", pendingId, entry });
    }
  };
  const put = (entry: ActivityEntry) => {
    const known = feed.entries.some((existing) => existing.id === entry.id);
    feed = {
      nextId: Math.max(feed.nextId, entry.id + 1),
      entries: known
        ? feed.entries.map((existing) => (existing.id === entry.id ? entry : existing))
        : [...feed.entries, entry],
    };
    save([entry]);
  };
  const fold = (event: BuildStepEvent) => {
    const folded = foldHookEvent(feed, [], event);
    feed = folded.feed;
    save(folded.changed);
    for (const { entryId, field, text } of folded.cut) {
      activity.appendBuildStepText(pendingId, entryId, field, text);
    }
  };
  const pieces = (matches: (entry: SubagentEntry) => boolean) =>
    feed.entries.filter(
      (entry): entry is SubagentEntry => entry.kind === "subagent" && matches(entry),
    );

  const record = (call: AgentCall, report?: string): void => {
    const { piece } = call;
    if (piece === undefined) return;
    const key = call.toolUseId ?? piece;
    const started = call.status === undefined;
    const id = (started ? undefined : running.get(key)) ?? feed.nextId;
    if (started) running.set(key, id);
    else running.delete(key);
    const agentId = call.agentId ?? pieces((entry) => entry.id === id)[0]?.agentId;
    put({
      id,
      nodeId: piece,
      at: now(),
      summary: piece,
      kind: "subagent",
      agentType: call.agentType ?? "general-purpose",
      state: started ? "running" : "finished",
      ...(call.toolUseId === undefined ? {} : { toolUseId: call.toolUseId }),
      ...(agentId === undefined ? {} : { agentId }),
      ...(report === undefined ? {} : { report: previewOf(report) }),
    });
    if (report !== undefined && previewOf(report) !== report) {
      activity.appendBuildStepText(pendingId, id, "report", report);
    }
    if (started || agentId === undefined) return;
    const waiting = held.get(agentId) ?? [];
    held.delete(agentId);
    for (const event of waiting) fold(event);
  };

  const step = (event: BuildStepEvent): void => {
    const agentId = event.payload["agent_id"];
    if (typeof agentId !== "string") return;
    if (pieces((entry) => entry.agentId === agentId).length > 0) return fold(event);
    const waiting = held.get(agentId);
    if (waiting !== undefined) {
      waiting.push(event);
      return;
    }
    const agentType = event.payload["agent_type"];
    const candidates = pieces(
      (entry) =>
        entry.state === "running" && entry.agentId === undefined && entry.agentType === agentType,
    );
    const [only, ...others] = candidates;
    if (only === undefined) return;
    if (others.length > 0) {
      held.set(agentId, [event]);
      return;
    }
    put({ ...only, agentId });
    fold(event);
  };

  return Object.assign(record, { step });
}
