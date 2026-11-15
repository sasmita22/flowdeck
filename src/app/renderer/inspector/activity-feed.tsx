import type { CSSProperties } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import type { ActivityEntry } from "../../../core/run/activity.js";
import type { RunView } from "../run-store.js";
import { runNodeLabel, type RunLabels } from "./inspector.js";
import { entryText, selectActivity, type InspectorState } from "./store.js";

const clipped: CSSProperties = {
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const entryStyle: CSSProperties = {
  ...clipped,
  display: "block",
  width: "100%",
  textAlign: "left",
  fontSize: "var(--fs-sm)",
  padding: "4px 6px",
};

export function ActivityFeed({
  inspector,
  run,
  labels,
  onSelectNode,
  stored,
}: {
  inspector: StoreApi<InspectorState>;
  run: StoreApi<RunView>;
  labels: RunLabels;
  onSelectNode: (nodeId: string) => void;
  stored?: readonly ActivityEntry[] | undefined;
}) {
  const runId = useStore(run, (state) => state.snapshot?.runId);
  const feed = useStore(inspector, (state) => state.feed);
  return (
    <ActivityList
      entries={selectActivity({ feed }, runId, stored ?? [])}
      labels={labels}
      onSelectNode={onSelectNode}
    />
  );
}

export function ActivityList({
  entries,
  labels,
  onSelectNode,
}: {
  entries: readonly ActivityEntry[];
  labels: RunLabels;
  onSelectNode: (nodeId: string) => void;
}) {
  if (entries.length === 0) return <p data-testid="activity-empty">No activity yet</p>;
  return (
    <ol style={{ listStyle: "none", margin: 0, padding: 0, minWidth: 0 }}>
      {entries.map((entry) => (
        <li key={entry.id} style={{ minWidth: 0 }}>
          <button
            data-testid={`activity-entry-${entry.id}`}
            data-node-id={entry.nodeId}
            data-kind={entry.kind}
            title={entryText(entry)}
            style={entryStyle}
            onClick={() => onSelectNode(entry.nodeId)}
          >
            <strong>{runNodeLabel(labels, entry.nodeId)}</strong> {entryText(entry)}
          </button>
        </li>
      ))}
    </ol>
  );
}
