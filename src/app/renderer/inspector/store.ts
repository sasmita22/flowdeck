import { createStore, type StoreApi } from "zustand/vanilla";
import {
  activityFeedSchema,
  activityUpdateSchema,
  type ActivityEntry,
} from "../../../core/run/activity.js";
import type { FlowdeckBridge } from "../../preload/bridge.js";

export type InspectorBridge = Pick<FlowdeckBridge, "getActivity" | "onActivity">;

type Feed = { runId: string; entries: ActivityEntry[] };

export type InspectorState = {
  feed: Feed | null;
  connect(): Promise<void>;
};

const merge = (older: readonly ActivityEntry[], newer: readonly ActivityEntry[]) => {
  const byId = new Map(older.map((entry) => [entry.id, entry]));
  for (const entry of newer) byId.set(entry.id, entry);
  return [...byId.values()];
};

export const selectActivity = (
  state: Pick<InspectorState, "feed">,
  runId: string | undefined,
): ActivityEntry[] =>
  state.feed === null || state.feed.runId !== runId
    ? []
    : [...state.feed.entries].sort((a, b) => b.id - a.id);

export const createInspectorStore = ({
  bridge,
}: {
  bridge: InspectorBridge;
}): StoreApi<InspectorState> =>
  createStore<InspectorState>()((set, get) => ({
    feed: null,

    connect: async () => {
      bridge.onActivity((value) => {
        const parsed = activityUpdateSchema.safeParse(value);
        if (!parsed.success) return;
        const { runId, entry } = parsed.data;
        const { feed } = get();
        const kept = feed?.runId === runId ? feed.entries : [];
        set({ feed: { runId, entries: merge(kept, [entry]) } });
      });
      const fetched = activityFeedSchema.safeParse(await bridge.getActivity());
      if (!fetched.success) return;
      const { feed } = get();
      if (feed === null) set({ feed: fetched.data });
      else if (feed.runId === fetched.data.runId)
        set({ feed: { runId: feed.runId, entries: merge(fetched.data.entries, feed.entries) } });
    },
  }));
