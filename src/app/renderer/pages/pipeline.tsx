import { useEffect } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import { displayStatus, type DisplayStatus } from "../../../core/run/display.js";
import type {
  BudgetPause,
  PipelineItem,
  PipelineStage,
  TimelineEvent,
} from "../../../core/run/pipeline.js";
import type { SnapshotStatus } from "../../../core/run/snapshot.js";
import type { NodeState } from "../../../core/run/state.js";
import type { HumanDecision } from "../../../core/run/wait.js";
import { labelFor } from "../../../core/nodes/defaults.js";
import { statusBadge } from "../canvas/status-look.js";
import { formatCost, formatDuration, formatTokens, formatWhen } from "../format.js";
import { ActivityList } from "../inspector/activity-feed.js";
import type { RunLabels } from "../inspector/inspector.js";
import { stepsEndedOf, type InspectorState } from "../inspector/store.js";
import {
  selectRunSnapshot,
  type RunState,
  type RunView,
  type StageSelection,
} from "../run-store.js";
import { pageTestIds } from "../test-ids.js";
import { LiveElapsed } from "./pipeline-parts.js";

type Placed = { stage: PipelineStage; round: number | undefined };

type Live = Readonly<Record<string, NodeState>> | undefined;

const isStage = (item: PipelineItem): item is PipelineStage => "nodeId" in item;

const placedIn = (items: readonly PipelineItem[], round?: number): Placed[] =>
  items.flatMap((item) =>
    isStage(item)
      ? [
          { stage: item, round },
          ...(item.rounds ?? []).flatMap((each) => placedIn(each.items, each.round)),
        ]
      : item.lanes.flatMap((lane) => placedIn(lane, round)),
  );

const stateOf = (placed: Placed, live: Live): NodeState =>
  (placed.round === undefined ? live?.[placed.stage.nodeId] : undefined) ?? placed.stage.status;

const chosenStage = (
  items: readonly PipelineItem[],
  selection: StageSelection | undefined,
  live: Live,
  runStatus: SnapshotStatus,
): Placed | undefined => {
  const all = placedIn(items);
  if (selection !== undefined) {
    const matching = all.filter((placed) => placed.stage.nodeId === selection.nodeId);
    return matching.find((placed) => placed.round === selection.round) ?? matching.at(-1);
  }
  const top = all.filter((placed) => placed.round === undefined);
  const needsLook: NodeState[] = runStatus === "running" ? ["failed", "needs-you"] : ["failed"];
  return (
    top.find((placed) => needsLook.includes(stateOf(placed, live))) ??
    top.findLast((placed) => stateOf(placed, live) !== "waiting") ??
    top[0]
  );
};

const eventNames: Record<TimelineEvent["kind"], string> = {
  sent: "Sent",
  running: "Started",
  retry: "Retried",
  "needs-you": "Waited for you",
  skipped: "Skipped",
  reset: "Reset",
  done: "Done",
  failed: "Failed",
  decided: "Decided",
  answered: "Answered",
  round: "New round",
  usage: "Used",
  compacted: "Compacted",
  budget: "Budget",
};

const eventText = (event: TimelineEvent) =>
  event.tokens === undefined
    ? eventNames[event.kind]
    : `${eventNames[event.kind]} ${formatTokens(event.tokens)} · ${formatCost(event.cost ?? 0)}`;

const decisionText = (decision: HumanDecision) => {
  if (decision.decision === "answered") return `Answered: ${decision.answer}`;
  if (decision.decision === "rejected" || decision.decision === "stopped")
    return `${decision.decision === "rejected" ? "Rejected" : "Stopped"}: ${decision.reason}`;
  return decision.decision === "approved"
    ? "Approved"
    : decision.decision === "skipped"
      ? "Skipped"
      : "Continued";
};

const pauseText = (pause: BudgetPause) =>
  `Paused at ${formatCost(pause.spend)} of a ${formatCost(pause.budget)} budget${pause.unconfirmed === true ? " (spend not confirmed)" : ""}`;

const stageName = (stage: PipelineStage, round: number | undefined) =>
  `${labelFor(stage)}${round === undefined ? "" : ` · round ${round}`}`;

function StageTook({ stage, shown }: { stage: PipelineStage; shown: DisplayStatus }) {
  if (stage.ms !== undefined) return <>{formatDuration(stage.ms)}</>;
  if (stage.startedAt !== undefined && (shown === "running" || shown === "sent"))
    return <LiveElapsed since={stage.startedAt} />;
  return null;
}

type RailProps = {
  runId: string;
  live: Live;
  runStatus: SnapshotStatus;
  chosen: Placed | undefined;
  onSelect: (selection: StageSelection) => void;
};

function StageRow({ placed, ...rail }: RailProps & { placed: Placed }) {
  const { runId, live, runStatus, chosen, onSelect } = rail;
  const { stage, round } = placed;
  const shown = displayStatus(stateOf(placed, live), runStatus);
  const selected = chosen?.stage === stage;
  return (
    <li className="fd-run-step">
      <button
        className="fd-file-row fd-run-stage"
        data-testid={pageTestIds.runStage(runId, stage.nodeId, round)}
        aria-current={selected ? "true" : undefined}
        onClick={() =>
          onSelect(round === undefined ? { nodeId: stage.nodeId } : { nodeId: stage.nodeId, round })
        }
      >
        <span
          className="fd-run-dot"
          data-testid={pageTestIds.runStageStatus(runId, stage.nodeId, round)}
          data-status={shown}
          style={{ background: statusBadge(shown).color }}
        >
          <span className="fd-visually-hidden">{shown}</span>
        </span>
        <span className="fd-ellipsis">{labelFor(stage)}</span>
        <span className="fd-pipeline-took">
          <StageTook stage={stage} shown={shown} />
          {stage.cost !== undefined && stage.cost > 0 && ` · ${formatCost(stage.cost)}`}
        </span>
      </button>
      {stage.rounds !== undefined && stage.rounds.length > 0 && (
        <ol className="fd-run-rounds" aria-label={`${labelFor(stage)} rounds`}>
          {stage.rounds.map((each) => (
            <li key={each.round} className="fd-run-round">
              <span className="fd-run-round-name fd-ellipsis">
                Round {each.round}
                {each.item === undefined ? "" : ` · ${each.item}`}
                {each.cost !== undefined && each.cost > 0 && (
                  <span data-testid={pageTestIds.runRoundCost(runId, stage.nodeId, each.round)}>
                    {` · ${formatCost(each.cost)}`}
                  </span>
                )}
              </span>
              <Rail {...rail} items={each.items} round={each.round} label={`Round ${each.round}`} />
            </li>
          ))}
        </ol>
      )}
    </li>
  );
}

function Rail({
  items,
  round,
  label,
  className = "fd-run-rail",
  ...rail
}: RailProps & {
  items: readonly PipelineItem[];
  round: number | undefined;
  label: string;
  className?: string;
}) {
  return (
    <ol className={className} aria-label={label}>
      {items.map((item, index) =>
        isStage(item) ? (
          <StageRow key={item.nodeId} {...rail} placed={{ stage: item, round }} />
        ) : (
          <li key={`parallel-${index}`} className="fd-run-step fd-run-parallel">
            <div className="fd-run-lanes">
              {item.lanes.map((lane, laneIndex) => (
                <Rail
                  key={laneIndex}
                  {...rail}
                  items={lane}
                  round={round}
                  label={`Branch ${laneIndex + 1}`}
                  className="fd-run-rail fd-run-lane"
                />
              ))}
            </div>
          </li>
        ),
      )}
    </ol>
  );
}

function StageDetail({
  runId,
  placed,
  state,
  runStatus,
  run,
  labels,
  canRetry,
  onSelectNode,
}: {
  runId: string;
  placed: Placed;
  state: NodeState;
  runStatus: SnapshotStatus;
  run: StoreApi<RunState>;
  labels: RunLabels;
  canRetry: boolean;
  onSelectNode: (nodeId: string) => void;
}) {
  const { stage, round } = placed;
  const shown = displayStatus(state, runStatus);
  return (
    <section
      className="fd-run-detail"
      data-testid={pageTestIds.runStageDetail(runId, stage.nodeId, round)}
      aria-label="Stage"
    >
      <h2 className="fd-run-detail-title">
        <span className="fd-ellipsis">{stageName(stage, round)}</span>
        <span style={{ color: statusBadge(shown).color }}>{shown}</span>
      </h2>
      {shown === "failed" && stage.reason !== undefined && (
        <p
          className="fd-pipeline-error"
          data-testid={pageTestIds.runStageReason(runId, stage.nodeId, round)}
        >
          {stage.reason}
        </p>
      )}
      {shown === "failed" && canRetry && (
        <div>
          <button
            className="fd-btn"
            data-testid={pageTestIds.runStageRetry(runId, stage.nodeId, round)}
            title="Send this stage again and carry on from it"
            onClick={() => void run.getState().retry(runId, stage.nodeId)}
          >
            Retry
          </button>
        </div>
      )}
      {stage.reply !== undefined && (
        <>
          <h3 className="fd-run-detail-heading">Final reply</h3>
          <p
            className="fd-run-reply"
            data-testid={pageTestIds.runStageReply(runId, stage.nodeId, round)}
          >
            {stage.reply}
          </p>
        </>
      )}
      <h3 className="fd-run-detail-heading">Timeline</h3>
      <ol className="fd-run-timeline">
        {stage.timeline.map((event) => (
          <li key={event.seq}>
            <time className="fd-muted">{formatWhen(event.time)}</time> {eventText(event)}
          </li>
        ))}
        {stage.decisions.map((decision, index) => (
          <li key={`decision-${index}`}>{decisionText(decision)}</li>
        ))}
        {stage.budgetPauses.map((pause, index) => (
          <li key={`pause-${index}`}>{pauseText(pause)}</li>
        ))}
        {stage.timeline.length === 0 && <li className="fd-muted">Not started</li>}
      </ol>
      <h3 className="fd-run-detail-heading">Activity</h3>
      <ActivityList
        entries={[...stage.activity].sort((a, b) => b.id - a.id)}
        labels={labels}
        onSelectNode={onSelectNode}
        withSteps
        stepsEnded={stepsEndedOf(runStatus, shown)}
      />
    </section>
  );
}

export function RunPipeline({
  runId,
  recorded,
  run,
  view,
  inspector,
  labels,
  canRetry,
}: {
  runId: string;
  recorded: boolean;
  run: StoreApi<RunState>;
  view: StoreApi<RunView>;
  inspector: StoreApi<InspectorState>;
  labels: RunLabels;
  canRetry: boolean;
}) {
  const pipeline = useStore(run, (state) => state.pipelines[runId]);
  const selection = useStore(run, (state) => state.selectedStage[runId]);
  const changed = useStore(run, (state) => JSON.stringify(selectRunSnapshot(state, runId)));
  const activityCount = useStore(inspector, (state) =>
    state.feed?.runId === runId ? state.feed.entries.length : 0,
  );
  const live = useStore(view, (state) => state.snapshot?.nodes);
  const runStatus = useStore(view, (state) => state.snapshot?.status ?? "running");

  useEffect(() => {
    if (recorded) void run.getState().loadPipeline(runId);
  }, [run, runId, recorded, changed, activityCount]);

  useEffect(
    () => (recorded && runStatus === "running" ? run.getState().watchCost(runId) : undefined),
    [run, runId, recorded, runStatus],
  );

  if (!recorded || pipeline === null) {
    return (
      <p className="fd-page-note" data-testid={pageTestIds.runStagesNotRecorded}>
        This run's stages were not recorded.
      </p>
    );
  }
  if (pipeline === undefined) return <p className="fd-muted">Reading the stages…</p>;
  const chosen = chosenStage(pipeline, selection, live, runStatus);
  const onSelect = (stage: StageSelection) => run.getState().selectStage(runId, stage);
  return (
    <div className="fd-pipeline">
      <Rail
        items={pipeline}
        round={undefined}
        label="Stages"
        className="fd-file-list fd-run-rail fd-pipeline-rail"
        runId={runId}
        live={live}
        runStatus={runStatus}
        chosen={chosen}
        onSelect={onSelect}
      />
      <div className="fd-pipeline-detail">
        {chosen !== undefined && (
          <StageDetail
            runId={runId}
            placed={chosen}
            state={stateOf(chosen, live)}
            runStatus={runStatus}
            run={run}
            labels={labels}
            canRetry={canRetry}
            onSelectNode={(nodeId) => onSelect({ nodeId })}
          />
        )}
      </div>
    </div>
  );
}
