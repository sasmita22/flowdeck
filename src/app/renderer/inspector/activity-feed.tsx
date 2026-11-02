import type { CSSProperties } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import type { ActivityEntry } from "../../../core/run/activity.js";
import type { CanvasState } from "../canvas/store.js";
import type { RunView } from "../run-store.js";
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

const outputStyle: CSSProperties = {
  margin: "0 6px 4px",
  maxHeight: 96,
  overflow: "auto",
  padding: "4px 6px",
  borderRadius: 4,
  background: "var(--term-bg)",
  color: "var(--term-fg)",
  font: "var(--fs-xs)/1.4 var(--f-mono)",
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
};

export function ActivityFeed({
  inspector,
  run,
  canvas,
  stored,
}: {
  inspector: StoreApi<InspectorState>;
  run: StoreApi<RunView>;
  canvas: StoreApi<CanvasState>;
  stored?: readonly ActivityEntry[] | undefined;
}) {
  const runId = useStore(run, (state) => state.snapshot?.runId);
  const feed = useStore(inspector, (state) => state.feed);
  const nodes = useStore(canvas, (state) => state.flow.nodes);
  const entries = selectActivity({ feed }, runId, stored ?? []);
  if (entries.length === 0) return <p data-testid="activity-empty">No activity yet</p>;
  const labelOf = (nodeId: string) => nodes.find((node) => node.id === nodeId)?.label ?? nodeId;
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
            onClick={() => canvas.getState().highlight(entry.nodeId)}
          >
            <strong>{labelOf(entry.nodeId)}</strong> {entryText(entry)}
          </button>
          {entry.kind === "output" && entry.text.includes("\n") && (
            <pre data-testid={`activity-output-${entry.id}`} style={outputStyle}>
              {entry.text}
            </pre>
          )}
        </li>
      ))}
    </ol>
  );
}
