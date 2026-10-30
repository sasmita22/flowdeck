import type { CSSProperties } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import type { ActivityEntry } from "../../../core/run/activity.js";
import type { CanvasState } from "../canvas/store.js";
import type { RunState } from "../run-store.js";
import { selectActivity, type InspectorState } from "./store.js";

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
  fontSize: 12,
  padding: "4px 6px",
};

const entryText = (entry: ActivityEntry): string =>
  entry.kind === "tool"
    ? `${entry.tool} ${entry.summary}`
    : `${entry.agentType} ${entry.summary} ${entry.state}`;

export function ActivityFeed({
  inspector,
  run,
  canvas,
}: {
  inspector: StoreApi<InspectorState>;
  run: StoreApi<RunState>;
  canvas: StoreApi<CanvasState>;
}) {
  const runId = useStore(run, (state) => state.snapshot?.runId);
  const feed = useStore(inspector, (state) => state.feed);
  const nodes = useStore(canvas, (state) => state.flow.nodes);
  const entries = selectActivity({ feed }, runId);
  if (entries.length === 0) return <p data-testid="activity-empty">No activity yet</p>;
  const labelOf = (nodeId: string) => nodes.find((node) => node.id === nodeId)?.label ?? nodeId;
  return (
    <ol style={{ listStyle: "none", margin: 0, padding: 0, minWidth: 0 }}>
      {entries.map((entry) => (
        <li key={entry.id} style={{ minWidth: 0 }}>
          <button
            data-testid={`activity-entry-${entry.id}`}
            data-node-id={entry.nodeId}
            style={entryStyle}
            onClick={() => canvas.getState().highlight(entry.nodeId)}
          >
            <strong>{labelOf(entry.nodeId)}</strong> {entryText(entry)}
          </button>
        </li>
      ))}
    </ol>
  );
}
