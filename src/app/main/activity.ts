import type { ActivityEntry } from "../../core/run/activity.js";
import type { EnginePush } from "../engine/protocol.js";

type ActivityUpdate = { runId: string; entry: ActivityEntry };
type ActivityFeedSnapshot = { runId: string; entries: ActivityEntry[] };

export type ActivityRelay = {
  onPush(push: EnginePush): void;
  feed(): ActivityFeedSnapshot | null;
};

export function createActivityRelay(options: {
  send: (update: ActivityUpdate) => void;
}): ActivityRelay {
  let runId: string | null = null;
  const entries = new Map<number, ActivityEntry>();
  return {
    onPush(push) {
      if (push.push !== "activity") return;
      const { value } = push;
      if (value.runId !== runId) {
        runId = value.runId;
        entries.clear();
      }
      entries.set(value.entry.id, value.entry);
      options.send(value);
    },
    feed: () =>
      runId === null ? null : { runId, entries: [...entries.values()].sort((a, b) => a.id - b.id) },
  };
}
