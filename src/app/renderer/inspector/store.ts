import { createStore, type StoreApi } from "zustand/vanilla";
import {
  activityFeedSchema,
  activityUpdateSchema,
  firstAtOrAfter,
  type ActivityEntry,
} from "../../../core/run/activity.js";
import type { DisplayStatus } from "../../../core/run/display.js";
import type { SnapshotStatus } from "../../../core/run/snapshot.js";
import type { FlowdeckBridge } from "../../preload/bridge.js";

export type InspectorBridge = Pick<FlowdeckBridge, "getActivity" | "onActivity">;

type Feed = { runId: string; entries: ActivityEntry[] };

export type InspectorState = {
  runId: string | null;
  feed: Feed | null;
  connect(): Promise<void>;
  view(runId: string): Promise<void>;
};

const none: readonly ActivityEntry[] = [];

const merge = (older: readonly ActivityEntry[], newer: readonly ActivityEntry[]) => {
  const merged: ActivityEntry[] = [];
  let o = 0;
  let n = 0;
  while (o < older.length || n < newer.length) {
    const left = older[o];
    const right = newer[n];
    if (right === undefined || (left !== undefined && left.id < right.id)) {
      merged.push(left as ActivityEntry);
      o += 1;
    } else {
      if (left?.id === right.id) o += 1;
      merged.push(right);
      n += 1;
    }
  }
  return merged;
};

const placed = (
  entries: readonly ActivityEntry[],
  positions: Map<number, number>,
  entry: ActivityEntry,
): ActivityEntry[] => {
  const existing = positions.get(entry.id);
  if (existing !== undefined) return entries.map((kept, at) => (at === existing ? entry : kept));
  const position = firstAtOrAfter(entries, entry.id);
  const next = [...entries.slice(0, position), entry, ...entries.slice(position)];
  for (let at = position; at < next.length; at += 1)
    positions.set((next[at] as ActivityEntry).id, at);
  return next;
};

const selected = new WeakMap<
  readonly ActivityEntry[],
  WeakMap<readonly ActivityEntry[], ActivityEntry[]>
>();

export const selectActivity = (
  state: Pick<InspectorState, "feed">,
  runId: string | undefined,
  stored: readonly ActivityEntry[] = none,
): ActivityEntry[] => {
  const feedEntries = state.feed === null || state.feed.runId !== runId ? none : state.feed.entries;
  const live = feedEntries.length === 0 ? none : feedEntries;
  const older = stored.length === 0 ? none : stored;
  let byStored = selected.get(live);
  if (byStored === undefined) {
    byStored = new WeakMap();
    selected.set(live, byStored);
  }
  const cached = byStored.get(older);
  if (cached !== undefined) return cached;
  const newestFirst = merge(older, live).reverse();
  byStored.set(older, newestFirst);
  return newestFirst;
};

const endedOnItsOwn = (status: SnapshotStatus | DisplayStatus | undefined) =>
  status === "done" || status === "failed";

export const stepsEndedOf = (
  runStatus: SnapshotStatus | undefined,
  stageStatus?: DisplayStatus,
): boolean => endedOnItsOwn(runStatus) || (runStatus === "running" && endedOnItsOwn(stageStatus));

function stepOutcome(entry: Extract<ActivityEntry, { kind: "tool" }>, ended: boolean): string {
  if (entry.result !== undefined) {
    const duration =
      entry.durationMs === undefined ? "" : ` · ${(entry.durationMs / 1000).toFixed(1)}s`;
    return ` · ${entry.result}${duration}`;
  }
  if (entry.input === undefined) return "";
  return ended ? " · no result" : " · running";
}

export function entryText(
  entry: ActivityEntry,
  { ended = false }: { ended?: boolean } = {},
): string {
  switch (entry.kind) {
    case "tool":
      return `${entry.tool} ${entry.summary}${stepOutcome(entry, ended)}`;
    case "subagent":
      return `${entry.agentType} ${entry.summary} ${entry.state}`;
    case "turn":
      return `Turn ended: ${entry.summary}`;
    case "failure":
      return `Failed: ${entry.summary}`;
    case "context":
    case "kept":
      return entry.summary;
    case "pr":
      return `Opened ${entry.url}`;
  }
}

export type WrittenFiles = {
  nodes: { nodeId: string; paths: string[] }[];
  pullRequests: { nodeId: string; url: string }[];
};

type FileNodes = readonly { id: string }[];

const filesSelected = new WeakMap<readonly ActivityEntry[], WeakMap<FileNodes, WrittenFiles>>();

function deriveFiles(entries: readonly ActivityEntry[], nodes: FileNodes): WrittenFiles {
  const nodeOrder = nodes.map((node) => node.id);
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

export function selectFiles(entries: readonly ActivityEntry[], nodes: FileNodes): WrittenFiles {
  let byNodes = filesSelected.get(entries);
  if (byNodes === undefined) {
    byNodes = new WeakMap();
    filesSelected.set(entries, byNodes);
  }
  const cached = byNodes.get(nodes);
  if (cached !== undefined) return cached;
  const files = deriveFiles(entries, nodes);
  byNodes.set(nodes, files);
  return files;
}

export const createInspectorStore = ({
  bridge,
}: {
  bridge: InspectorBridge;
}): StoreApi<InspectorState> =>
  createStore<InspectorState>()((set, get) => {
    let indexed = none;
    let positions = new Map<number, number>();

    const positionsOf = (entries: readonly ActivityEntry[]) => {
      if (entries !== indexed) {
        positions = new Map(entries.map((entry, at) => [entry.id, at]));
        indexed = entries;
      }
      return positions;
    };

    return {
      runId: null,
      feed: null,

      connect: async () => {
        bridge.onActivity((value) => {
          const parsed = activityUpdateSchema.safeParse(value);
          if (!parsed.success || parsed.data.runId !== get().runId) return;
          const { runId, entry } = parsed.data;
          const { feed } = get();
          const kept = feed?.runId === runId ? feed.entries : none;
          const entries = placed(kept, positionsOf(kept), entry);
          indexed = entries;
          set({ feed: { runId, entries } });
        });
      },

      view: async (runId) => {
        set({ runId, feed: null });
        const fetched = activityFeedSchema.safeParse(await bridge.getActivity(runId));
        if (!fetched.success || get().runId !== runId) return;
        const { feed } = get();
        if (feed === null) set({ feed: fetched.data });
        else if (feed.runId === fetched.data.runId)
          set({ feed: { runId: feed.runId, entries: merge(fetched.data.entries, feed.entries) } });
      },
    };
  });
