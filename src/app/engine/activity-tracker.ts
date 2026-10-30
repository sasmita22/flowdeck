import { emptyFeed, foldHookEvent, type ActivityFeed } from "../../core/run/activity.js";
import { trackWindow, type NodeWindow } from "../../core/run/attribution.js";
import type { TurnEvents } from "../../core/run/turns.js";
import type { EventEntry, Store } from "../../ports/store.js";
import type { EnginePush } from "./protocol.js";

export type ActivityTrackerOptions = {
  runId: string;
  now: () => number;
  publish: (push: EnginePush) => void;
  log: (line: string) => void;
};

export type ActivityTracker = {
  store(inner: Store): Store;
  watch(events: TurnEvents, sessionId: string): () => void;
};

export function createActivityTracker(options: ActivityTrackerOptions): ActivityTracker {
  const { runId, now, publish, log } = options;
  let windows: NodeWindow[] = [];
  let feed: ActivityFeed = emptyFeed;

  const track = (id: string, entries: readonly EventEntry[]): void => {
    if (id !== runId) return;
    const at = now();
    for (const { nodeId, event } of entries) windows = trackWindow(windows, nodeId, event.kind, at);
  };

  const handlerFor =
    (kind: "PreToolUse" | "SubagentStop") =>
    ({ payload }: { payload: Record<string, unknown> }): void => {
      try {
        const folded = foldHookEvent(feed, windows, { kind, payload });
        feed = folded.feed;
        if (folded.changed !== undefined) {
          publish({ push: "activity", value: { runId, entry: folded.changed } });
        }
      } catch (error) {
        log(error instanceof Error ? error.message : String(error));
      }
    };

  return {
    store: (inner) => ({
      createRun: (run) => inner.createRun(run),
      findRun: (id) => inner.findRun(id),
      events: (id) => inner.events(id),
      finishRun: (id, status) => inner.finishRun(id, status),
      recordBuild: (build) => inner.recordBuild(build),
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
      const unsubscribes = [
        events.subscribe("PreToolUse", sessionId, handlerFor("PreToolUse")),
        events.subscribe("SubagentStop", sessionId, handlerFor("SubagentStop")),
      ];
      return () => {
        for (const unsubscribe of unsubscribes) unsubscribe();
      };
    },
  };
}
