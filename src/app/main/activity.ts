import type { ActivityEntry } from "../../core/run/activity.js";
import type { EnginePush } from "../engine/protocol.js";

type ActivityUpdate = { runId: string; entry: ActivityEntry };
type ActivityFeedSnapshot = { runId: string; entries: ActivityEntry[] };

type ActivityRelay = {
  onPush(push: EnginePush): void;
  onRunState(push: EnginePush): void;
  feed(runId: string): ActivityFeedSnapshot | null;
};

export function createActivityRelay(options: {
  send: (update: ActivityUpdate) => void;
}): ActivityRelay {
  const feeds = new Map<string, Map<number, ActivityEntry>>();
  const ended = new Set<string>();
  return {
    onPush(push) {
      if (push.push !== "activity") return;
      const { value } = push;
      options.send(value);
      if (ended.has(value.runId)) return;
      const entries = feeds.get(value.runId) ?? new Map<number, ActivityEntry>();
      feeds.set(value.runId, entries);
      entries.set(value.entry.id, value.entry);
    },
    onRunState(push) {
      if (push.push !== "run-state") return;
      const { runId, status } = push.value;
      if (status === "running") {
        ended.delete(runId);
      } else if (status === "done" || status === "failed" || status === "stopped") {
        ended.add(runId);
        feeds.delete(runId);
      }
    },
    feed(runId) {
      const entries = feeds.get(runId);
      return entries === undefined
        ? null
        : { runId, entries: [...entries.values()].sort((a, b) => a.id - b.id) };
    },
  };
}
