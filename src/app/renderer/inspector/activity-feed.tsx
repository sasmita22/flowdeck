import type { CSSProperties } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import type { ActivityEntry } from "../../../core/run/activity.js";
import { formatClock } from "../format.js";
import type { RunView } from "../run-store.js";
import { runNodeLabel, type RunLabels } from "./inspector.js";
import { entryText, selectActivity, stepsEndedOf, type InspectorState } from "./store.js";

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
  const runStatus = useStore(run, (state) => state.snapshot?.status);
  const feed = useStore(inspector, (state) => state.feed);
  return (
    <ActivityList
      entries={selectActivity({ feed }, runId, stored ?? [])}
      labels={labels}
      onSelectNode={onSelectNode}
      stepsEnded={stepsEndedOf(runStatus)}
    />
  );
}

const stepDetailOf = (entry: ActivityEntry): { input?: string; output?: string } => {
  if (entry.kind === "tool")
    return {
      ...(entry.input === undefined ? {} : { input: entry.input }),
      ...(entry.output === undefined ? {} : { output: entry.output }),
    };
  if (entry.kind === "subagent" && entry.report !== undefined) return { output: entry.report };
  return {};
};

function StepDetail({ entry }: { entry: ActivityEntry }) {
  const { input, output } = stepDetailOf(entry);
  if (input === undefined && output === undefined) return null;
  const testId = `activity-entry-${entry.id}`;
  return (
    <details data-testid={`${testId}-detail`} data-node-id={entry.nodeId}>
      <summary
        data-testid={`${testId}-summary`}
        data-node-id={entry.nodeId}
        style={{ fontSize: "var(--fs-sm)", padding: "0 6px" }}
      >
        Detail
      </summary>
      {input !== undefined && (
        <pre
          className="fd-file-content"
          data-testid={`${testId}-input`}
          data-node-id={entry.nodeId}
        >
          {input}
        </pre>
      )}
      {output !== undefined && (
        <pre
          className="fd-file-content"
          data-testid={`${testId}-output`}
          data-node-id={entry.nodeId}
        >
          {output}
        </pre>
      )}
    </details>
  );
}

export function ActivityList({
  entries,
  labels,
  onSelectNode,
  withSteps = false,
  stepsEnded = false,
}: {
  entries: readonly ActivityEntry[];
  labels: RunLabels;
  onSelectNode: (nodeId: string) => void;
  withSteps?: boolean;
  stepsEnded?: boolean;
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
            title={entryText(entry, { ended: stepsEnded })}
            style={entryStyle}
            onClick={() => onSelectNode(entry.nodeId)}
          >
            {withSteps && (
              <>
                <time
                  data-testid={`activity-entry-${entry.id}-time`}
                  data-node-id={entry.nodeId}
                  dateTime={new Date(entry.at).toISOString()}
                  className="fd-muted"
                >
                  {formatClock(entry.at)}
                </time>{" "}
              </>
            )}
            <strong>{runNodeLabel(labels, entry.nodeId)}</strong>{" "}
            {entryText(entry, { ended: stepsEnded })}
          </button>
          {withSteps && <StepDetail entry={entry} />}
        </li>
      ))}
    </ol>
  );
}
