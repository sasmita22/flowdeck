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
  stored: readonly ActivityEntry[] = [],
): ActivityEntry[] => {
  const live = state.feed === null || state.feed.runId !== runId ? [] : state.feed.entries;
  return merge(stored, live).sort((a, b) => b.id - a.id);
};

export function entryText(entry: ActivityEntry): string {
  switch (entry.kind) {
    case "tool":
      return `${entry.tool} ${entry.summary}`;
    case "subagent":
      return `${entry.agentType} ${entry.summary} ${entry.state}`;
    case "turn":
      return `Turn ended: ${entry.summary}`;
    case "output":
      return `${entry.stream === "stdout" ? "Output" : "Errors"}: ${entry.summary}`;
    case "failure":
      return `Failed: ${entry.summary}`;
    case "pr":
      return `Opened ${entry.url}`;
  }
}

export type WrittenFiles = {
  nodes: { nodeId: string; paths: string[] }[];
  pullRequests: { nodeId: string; url: string }[];
};

export function selectFiles(
  entries: readonly ActivityEntry[],
  nodeOrder: readonly string[],
): WrittenFiles {
  const ordered = [...entries].sort((a, b) => a.id - b.id);
  const paths = new Map<string, string[]>();
  for (const entry of ordered) {
    if (entry.kind !== "tool" || entry.path === undefined) continue;
    const known = paths.get(entry.nodeId) ?? [];
    if (!known.includes(entry.path)) paths.set(entry.nodeId, [...known, entry.path]);
  }
  const rank = (nodeId: string) => {
    const index = nodeOrder.indexOf(nodeId);
    return index === -1 ? nodeOrder.length : index;
  };
  return {
    nodes: [...paths]
      .map(([nodeId, list]) => ({ nodeId, paths: list }))
      .sort((a, b) => rank(a.nodeId) - rank(b.nodeId)),
    pullRequests: ordered.flatMap((entry) =>
      entry.kind === "pr" ? [{ nodeId: entry.nodeId, url: entry.url }] : [],
    ),
  };
}

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
