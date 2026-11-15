import type { CSSProperties } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import type { ActivityEntry } from "../../../core/run/activity.js";
import type { RunView } from "../run-store.js";
import { runNodeLabel, type RunLabels } from "./inspector.js";
import { selectActivity, selectFiles, type InspectorState } from "./store.js";

const pathStyle: CSSProperties = {
  margin: 0,
  padding: "2px 0",
  font: "var(--fs-xs)/1.4 var(--f-mono)",
  overflowWrap: "anywhere",
};

const headingStyle: CSSProperties = { fontSize: "var(--fs-sm)", margin: "12px 0 4px" };

export function FilesTab({
  inspector,
  run,
  labels,
  stored,
}: {
  inspector: StoreApi<InspectorState>;
  run: StoreApi<RunView>;
  labels: RunLabels;
  stored: readonly ActivityEntry[];
}) {
  const runId = useStore(run, (state) => state.snapshot?.runId);
  const feed = useStore(inspector, (state) => state.feed);
  const files = selectFiles(
    selectActivity({ feed }, runId, stored),
    labels.nodes.map((node) => node.id),
  );
  if (files.nodes.length === 0 && files.pullRequests.length === 0) {
    return <p data-testid="files-empty">No node has written a file yet</p>;
  }
  return (
    <div data-testid="files-tab">
      {files.pullRequests.length > 0 && (
        <>
          <h3 style={headingStyle}>Pull requests</h3>
          {files.pullRequests.map(({ nodeId, url }) => (
            <p key={url} data-testid="files-pr" style={pathStyle}>
              <strong>{runNodeLabel(labels, nodeId)}</strong> {url}
            </p>
          ))}
        </>
      )}
      {files.nodes.map(({ nodeId, paths }) => (
        <section key={nodeId} data-testid={`files-node-${nodeId}`}>
          <h3 style={headingStyle}>{runNodeLabel(labels, nodeId)}</h3>
          {paths.map((path) => (
            <p key={path} style={pathStyle}>
              {path}
            </p>
          ))}
        </section>
      ))}
    </div>
  );
}
