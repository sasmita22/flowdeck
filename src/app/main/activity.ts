import type { ActivityEntry } from "../../core/run/activity.js";
import type { EnginePush } from "../engine/protocol.js";

type ActivityUpdate = { runId: string; entry: ActivityEntry };
type ActivityFeedSnapshot = { runId: string; entries: ActivityEntry[] };

export type ActivityRelay = {
  onPush(push: EnginePush): void;
  feed(runId: string): ActivityFeedSnapshot | null;
};

export function createActivityRelay(options: {
  send: (update: ActivityUpdate) => void;
}): ActivityRelay {
  const feeds = new Map<string, Map<number, ActivityEntry>>();
  return {
    onPush(push) {
      if (push.push !== "activity") return;
      const { value } = push;
      const entries = feeds.get(value.runId) ?? new Map<number, ActivityEntry>();
      feeds.set(value.runId, entries);
      entries.set(value.entry.id, value.entry);
      options.send(value);
    },
    feed(runId) {
      const entries = feeds.get(runId);
      return entries === undefined
        ? null
        : { runId, entries: [...entries.values()].sort((a, b) => a.id - b.id) };
    },
  };
}
