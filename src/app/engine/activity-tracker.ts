import {
  feedOf,
  foldHookEvent,
  foldNodeEvent,
  foldOutput,
  type ActivityFeed,
  type ActivityHookEvent,
  type FoldResult,
  type WorkingPlace,
} from "../../core/run/activity.js";
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
  output(nodeId: string, stream: "stdout" | "stderr", text: string): void;
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
      recordActivity: (id, entry) => inner.recordActivity(id, entry),
      activity: (id) => inner.activity(id),
      recordCost: (id, totalCost) => inner.recordCost(id, totalCost),
      recordBuild: (build) => inner.recordBuild(build),
      findBuild: (hash) => inner.findBuild(hash),
      listBuilds: () => inner.listBuilds(),
      listRuns: () => inner.listRuns(),
      buildFiles: (hash) => inner.buildFiles(hash),
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
    output: (nodeId, stream, text) =>
      apply((current) => foldOutput(current, { nodeId, at: now(), stream, text })),
  };
}
