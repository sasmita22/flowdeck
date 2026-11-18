import type { CSSProperties } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import { isCut, type ActivityEntry } from "../../../core/run/activity.js";
import { formatClock } from "../format.js";
import type { RunView } from "../run-store.js";
import { selectFullText, type FullText, type FullTextStore } from "./full-text-store.js";
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

export type FullTextSource = { ownerId: string; store: FullTextStore };

const stepDetailOf = (entry: ActivityEntry): { input?: string; output?: string } => {
  if (entry.kind === "tool")
    return {
      ...(entry.input === undefined ? {} : { input: entry.input }),
      ...(entry.output === undefined ? {} : { output: entry.output }),
    };
  if (entry.kind === "subagent" && entry.report !== undefined) return { output: entry.report };
  return {};
};

const withFullText = (
  entry: ActivityEntry,
  shown: { input?: string; output?: string },
  full: FullText | undefined,
): { input?: string; output?: string } => {
  if (full?.kind !== "kept") return shown;
  const output = entry.kind === "subagent" ? full.texts.report : full.texts.output;
  return {
    ...(shown.input === undefined ? {} : { input: full.texts.input ?? shown.input }),
    ...(shown.output === undefined ? {} : { output: output ?? shown.output }),
  };
};

const missingText = (full: FullText | undefined) => {
  if (full?.kind === "not-kept") return "Full text was not kept";
  if (full?.kind === "failed") return full.error;
  return undefined;
};

function StepBody({
  entry,
  full,
  onShowFull,
}: {
  entry: ActivityEntry;
  full?: FullText | undefined;
  onShowFull?: (() => void) | undefined;
}) {
  const preview = stepDetailOf(entry);
  const { input, output } = withFullText(entry, preview, full);
  if (input === undefined && output === undefined) return null;
  const testId = `activity-entry-${entry.id}`;
  const cut = [preview.input, preview.output].some((text) => text !== undefined && isCut(text));
  const missing = missingText(full);
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
      {onShowFull !== undefined && cut && (full === undefined || full.kind === "loading") && (
        <button
          className="fd-btn"
          data-testid={`${testId}-full-text`}
          data-node-id={entry.nodeId}
          disabled={full?.kind === "loading"}
          onClick={onShowFull}
        >
          Show full text
        </button>
      )}
      {missing !== undefined && (
        <p
          className="fd-muted"
          data-testid={`${testId}-full-text-missing`}
          data-node-id={entry.nodeId}
        >
          {missing}
        </p>
      )}
    </details>
  );
}

function StepWithFullText({ entry, fullText }: { entry: ActivityEntry; fullText: FullTextSource }) {
  const { ownerId, store } = fullText;
  const full = useStore(store, (state) => selectFullText(state, ownerId, entry.id));
  return (
    <StepBody
      entry={entry}
      full={full}
      onShowFull={() => void store.getState().request(ownerId, entry.id)}
    />
  );
}

function StepDetail({
  entry,
  fullText,
}: {
  entry: ActivityEntry;
  fullText?: FullTextSource | undefined;
}) {
  return fullText === undefined ? (
    <StepBody entry={entry} />
  ) : (
    <StepWithFullText entry={entry} fullText={fullText} />
  );
}

export function ActivityList({
  entries,
  labels,
  onSelectNode,
  withSteps = false,
  stepsEnded = false,
  fullText,
}: {
  entries: readonly ActivityEntry[];
  labels: RunLabels;
  onSelectNode: (nodeId: string) => void;
  withSteps?: boolean;
  stepsEnded?: boolean;
  fullText?: FullTextSource | undefined;
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
          {withSteps && <StepDetail entry={entry} fullText={fullText} />}
        </li>
      ))}
    </ol>
  );
}
