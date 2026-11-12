import {
  feedOf,
  foldHookEvent,
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
import type { EventEntry, Store } from "../../ports/store.js";
import type { EnginePush } from "./protocol.js";

export type ActivityTrackerOptions = {
  runId: string;
  now: () => number;
  publish: (push: EnginePush) => void;
  log: (line: string) => void;
  activity: Pick<Store, "recordActivity" | "activity">;
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
      if (folded.changed === undefined) return;
      activity.recordActivity(runId, folded.changed);
      publish({ push: "activity", value: { runId, entry: folded.changed } });
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
      recordBuild: (build) => inner.recordBuild(build),
      findBuild: (id) => inner.findBuild(id),
      findBuildByName: (name) => inner.findBuildByName(name),
      deleteBuild: (id) => inner.deleteBuild(id),
      listBuilds: () => inner.listBuilds(),
      listBuildsWithDeleted: () => inner.listBuildsWithDeleted(),
      listRuns: () => inner.listRuns(),
      buildFiles: (id) => inner.buildFiles(id),
      startPendingBuild: (build) => inner.startPendingBuild(build),
      appendBuildEvent: (pendingId, event) => inner.appendBuildEvent(pendingId, event),
      buildEvents: (pendingId) => inner.buildEvents(pendingId),
      endPendingBuild: (pendingId, end) => inner.endPendingBuild(pendingId, end),
      listPendingBuilds: () => inner.listPendingBuilds(),
      listLatestEndedPendingBuilds: () => inner.listLatestEndedPendingBuilds(),
      findPendingBuildByName: (name) => inner.findPendingBuildByName(name),
      pendingBuild: (id) => inner.pendingBuild(id),
      appendBuildActivity: (pendingId, entry) => inner.appendBuildActivity(pendingId, entry),
      buildActivity: (pendingId) => inner.buildActivity(pendingId),
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
      const unsubscribes = (["PreToolUse", "PostToolUse", "SubagentStop"] as const).map((kind) =>
        events.subscribe(kind, sessionId, handlerFor(kind)),
      );
      return () => {
        for (const unsubscribe of unsubscribes) unsubscribe();
      };
    },
  };
}

export type BuildActivityOptions = {
  pendingId: string;
  now: () => number;
  activity: Pick<Store, "appendBuildActivity" | "buildActivity">;
  publish: (push: EnginePush) => void;
};

export function createBuildActivity({
  pendingId,
  now,
  activity,
  publish,
}: BuildActivityOptions): (call: AgentCall) => void {
  let { nextId } = feedOf(activity.buildActivity(pendingId));
  const running = new Map<string, number>();
  return (call) => {
    const { piece } = call;
    if (piece === undefined) return;
    const key = call.toolUseId ?? piece;
    const started = call.status === undefined;
    const id = (started ? undefined : running.get(key)) ?? nextId++;
    if (started) running.set(key, id);
    else running.delete(key);
    const entry: ActivityEntry = {
      id,
      nodeId: piece,
      at: now(),
      summary: piece,
      kind: "subagent",
      agentType: call.agentType ?? "general-purpose",
      state: started ? "running" : "finished",
      ...(call.toolUseId === undefined ? {} : { toolUseId: call.toolUseId }),
    };
    activity.appendBuildActivity(pendingId, entry);
    publish({ push: "build-activity", pendingId, entry });
  };
}
