import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import type { ActivityEntry } from "../../../core/run/activity.js";
import type {
  BuildPipeline,
  PipelineHeader,
  PipelineLane,
  PipelineRow,
} from "../../../core/run/build-pipeline.js";
import type {
  BuildCost,
  BuildQuestion,
  BuildStepNumber,
  StoredBuildEvent,
} from "../../../core/run/build-progress.js";
import { selectPipeline, type BuildProgressState } from "../build-progress-store.js";
import { formatCost, formatDuration, formatWhen } from "../format.js";
import { entryText } from "../inspector/store.js";
import type { LibraryState } from "../library-store.js";
import type { NavState } from "../nav-store.js";
import type { TerminalState } from "../terminal/store.js";
import { TerminalView } from "../terminal/terminal-pane.js";
import { controlTestIds, pageTestIds } from "../test-ids.js";
import { BlueprintPicture } from "./blueprint-picture.js";
import { BuildTree } from "./build-tree.js";
import { LaneTook, LiveElapsed, StatusIcon } from "./pipeline-parts.js";

const stageNames: Record<BuildStepNumber, string> = {
  1: "Check",
  2: "Lay down",
  3: "Write",
  4: "Check hand-offs",
  5: "Verify",
};

const statusNames: Record<PipelineHeader["status"], string> = {
  building: "Building",
  built: "Built",
  "needs-you": "Needs you",
  failed: "Failed",
  stopped: "Stopped",
};

const statusTones: Record<PipelineHeader["status"], string> = {
  building: "live",
  built: "ok",
  "needs-you": "warn",
  failed: "fail",
  stopped: "quiet",
};

type Selection = { step: BuildStepNumber; round: number; path?: string };

const costText = (cost: BuildCost) =>
  `${cost.inputTokens} in · ${cost.outputTokens} out · ${formatCost(cost.usd)}`;

const laneText = (lane: Pick<PipelineLane, "step" | "round">) =>
  `${lane.step} ${stageNames[lane.step]}${lane.round > 1 ? ` · round ${lane.round}` : ""}`;

const sameLane = (lane: Pick<PipelineLane, "step" | "round">, selection: Selection) =>
  lane.step === selection.step && lane.round === selection.round;

const defaultSelection = (pipeline: BuildPipeline): Selection | undefined =>
  pipeline.blockedLane ??
  pipeline.lanes.findLast((lane) => lane.status !== "waiting") ??
  pipeline.lanes[0];

const runningSince = (
  events: readonly StoredBuildEvent[],
  lane: Pick<PipelineLane, "step" | "round">,
): number | undefined =>
  events.find(
    (event) =>
      event.type === "step" &&
      event.step === lane.step &&
      (event.round ?? 1) === lane.round &&
      event.status === "running",
  )?.at;

function Elapsed({ header, testId }: { header: PipelineHeader; testId: string }) {
  if (header.endedAt === undefined) return <LiveElapsed since={header.startedAt} testId={testId} />;
  return <span data-testid={testId}>{formatDuration(header.endedAt - header.startedAt)}</span>;
}

function Fact({
  label,
  value,
  title,
}: {
  label: string;
  value: string;
  title?: string | undefined;
}) {
  return (
    <div>
      <dt>{label}</dt>
      <dd className="fd-ellipsis" title={title ?? value}>
        {value}
      </dd>
    </div>
  );
}

function BuildTerminal({ terminal }: { terminal: StoreApi<TerminalState> }) {
  return <TerminalView store={terminal} style={{ width: "100%", height: "40vh" }} />;
}

const answerStyle: CSSProperties = { flexBasis: "100%", maxWidth: 480 };

const rebuildErrorStyle: CSSProperties = {
  margin: 0,
  color: "var(--warn)",
  fontSize: "var(--fs-sm)",
};

function BuildQuestions({
  pendingId,
  questions,
  answerable,
  buildProgress,
}: {
  pendingId: string;
  questions: readonly BuildQuestion[];
  answerable: boolean;
  buildProgress: StoreApi<BuildProgressState>;
}) {
  const drafts = useStore(buildProgress, (state) => state.drafts[pendingId]);
  const canRebuild = useStore(buildProgress, (state) => state.canRebuild(pendingId));
  const error = useStore(buildProgress, (state) => state.rebuildErrorFor(pendingId));
  return (
    <div className="fd-pipeline-questions">
      <ol className="fd-build-steps" aria-label="Questions">
        {questions.map((question, index) => (
          <li key={index} data-testid={pageTestIds.buildQuestion(pendingId, index)}>
            <span>
              {question.nodeId}
              {question.otherNodeId === undefined ? "" : ` · ${question.otherNodeId}`}
            </span>
            <span>{question.text}</span>
            {answerable && (
              <input
                type="text"
                aria-label={`Answer to: ${question.text}`}
                placeholder="Your answer"
                style={answerStyle}
                data-testid={pageTestIds.buildAnswer(pendingId, index)}
                value={drafts?.[index] ?? ""}
                onChange={(event) =>
                  buildProgress.getState().setAnswer(pendingId, index, event.target.value)
                }
              />
            )}
          </li>
        ))}
      </ol>
      {answerable && (
        <div className="fd-page-bar">
          <button
            className="fd-btn fd-btn-primary"
            data-testid={pageTestIds.buildRebuild(pendingId)}
            title="Build this blueprint again with these answers"
            disabled={!canRebuild}
            onClick={() => void buildProgress.getState().rebuild(pendingId)}
          >
            Rebuild with answers
          </button>
          {error !== undefined && (
            <p role="alert" style={rebuildErrorStyle}>
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function RowView({
  pendingId,
  lane,
  row,
  selected,
  onSelect,
}: {
  pendingId: string;
  lane: PipelineLane;
  row: PipelineRow;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <li>
      <button
        className="fd-file-row fd-pipeline-row"
        data-testid={pageTestIds.buildRow(pendingId, lane.step, lane.round, row.path)}
        aria-current={selected ? "true" : undefined}
        title={row.path}
        onClick={onSelect}
      >
        <StatusIcon status={row.status} />
        <span className="fd-ellipsis">{row.labels.join(", ")}</span>
        {row.merged && <span className="fd-badge fd-badge-quiet">merged</span>}
        <span className="fd-pipeline-took fd-ellipsis">{row.path}</span>
      </button>
    </li>
  );
}

function LaneView({
  pendingId,
  lane,
  since,
  selection,
  onSelect,
  children,
}: {
  pendingId: string;
  lane: PipelineLane;
  since: number | undefined;
  selection: Selection | undefined;
  onSelect: (selection: Selection) => void;
  children?: ReactNode;
}) {
  const at = { step: lane.step, round: lane.round };
  const laneSelected =
    selection !== undefined && sameLane(lane, selection) && selection.path === undefined;
  return (
    <li>
      <button
        className="fd-file-row fd-pipeline-lane"
        data-testid={pageTestIds.buildStage(pendingId, lane.step, lane.round)}
        aria-current={laneSelected ? "true" : undefined}
        onClick={() => onSelect(at)}
      >
        <StatusIcon status={lane.status} />
        <span className="fd-ellipsis">{laneText(lane)}</span>
        <span className="fd-pipeline-took">
          <LaneTook lane={lane} since={since} />
        </span>
      </button>
      {lane.worktree !== undefined && (
        <div className="fd-pipeline-sub" data-testid={pageTestIds.buildWorktree(pendingId)}>
          <StatusIcon status={lane.worktree.status} />
          <span className="fd-ellipsis" title={lane.worktree.path}>
            Worktree {lane.worktree.branch}
          </span>
          {lane.worktree.message !== undefined && (
            <span className="fd-pipeline-error">{lane.worktree.message}</span>
          )}
        </div>
      )}
      {lane.rows.length > 0 && (
        <ul className="fd-pipeline-rows" aria-label={`${laneText(lane)} components`}>
          {lane.rows.map((row) => (
            <RowView
              key={row.path}
              pendingId={pendingId}
              lane={lane}
              row={row}
              selected={
                selection !== undefined && sameLane(lane, selection) && selection.path === row.path
              }
              onSelect={() => onSelect({ ...at, path: row.path })}
            />
          ))}
        </ul>
      )}
      {children}
    </li>
  );
}

function LogView({
  pendingId,
  lane,
  row,
}: {
  pendingId: string;
  lane: PipelineLane | undefined;
  row: PipelineRow | undefined;
}) {
  const entries: readonly ActivityEntry[] = row?.log ?? lane?.log ?? [];
  const notes =
    row === undefined && lane !== undefined
      ? [...(lane.failures ?? []), ...(lane.message === undefined ? [] : [lane.message])]
      : [];
  const title =
    lane === undefined
      ? ""
      : `${laneText(lane)}${row === undefined ? "" : ` · ${row.labels.join(", ")}`}`;
  return (
    <section
      className="fd-pipeline-log"
      data-testid={pageTestIds.buildActivity(pendingId)}
      aria-label="Log"
    >
      <h2 className="fd-page-note">{title}</h2>
      <div className="fd-file-content" tabIndex={0}>
        {notes.map((note, index) => (
          <div key={`note-${index}`} className="fd-pipeline-error">
            {note}
          </div>
        ))}
        {entries.map((entry) => (
          <div key={entry.id}>
            {entry.nodeId} <span className="fd-muted">{entryText(entry)}</span>
          </div>
        ))}
        {notes.length === 0 && entries.length === 0 && (
          <span className="fd-muted">No activity yet</span>
        )}
      </div>
    </section>
  );
}

function Header({
  pendingId,
  pipeline,
  blueprint,
  nav,
  buildProgress,
}: {
  pendingId: string;
  pipeline: BuildPipeline;
  blueprint: string | undefined;
  nav: StoreApi<NavState>;
  buildProgress: StoreApi<BuildProgressState>;
}) {
  const { header } = pipeline;
  const open = header.status === "building";
  return (
    <header className="fd-page-head">
      <nav className="fd-crumbs" aria-label="Breadcrumb">
        <button
          className="fd-crumb"
          data-testid={pageTestIds.buildBack}
          onClick={() => nav.getState().go({ name: "builds" })}
        >
          Builds
        </button>
        <span aria-hidden="true">/</span>
        <h1 className="fd-page-title fd-page-title-small" data-testid={pageTestIds.title}>
          {header.name}
        </h1>
        <span className={`fd-badge fd-badge-${statusTones[header.status]}`} role="status">
          {statusNames[header.status]}
        </span>
      </nav>
      <dl className="fd-facts">
        {blueprint !== undefined && <Fact label="Blueprint" value={blueprint} />}
        {header.repo !== undefined && <Fact label="Repo" value={header.repo} />}
        {header.branch !== undefined && (
          <Fact label="Branch" value={header.branch} title={header.path} />
        )}
        {header.base !== undefined && <Fact label="Base" value={header.base} />}
        <Fact label="Model" value={header.model ?? "default"} />
        <Fact label="Started" value={formatWhen(header.startedAt)} />
        <div>
          <dt>Elapsed</dt>
          <dd>
            <Elapsed header={header} testId={pageTestIds.buildElapsed(pendingId)} />
          </dd>
        </div>
      </dl>
      <div className="fd-page-bar">
        <p className="fd-page-note" data-testid={pageTestIds.buildCost(pendingId)}>
          {header.cost === undefined ? "" : costText(header.cost)}
        </p>
        {open && (
          <button
            className="fd-btn"
            data-testid={controlTestIds.buildStop}
            title="Stop the build and remove its workspace"
            onClick={() => void buildProgress.getState().stop(pendingId)}
          >
            Stop
          </button>
        )}
      </div>
    </header>
  );
}

function PipelineTree({
  pendingId,
  events,
  library,
}: {
  pendingId: string;
  events: readonly StoredBuildEvent[];
  library: StoreApi<LibraryState>;
}) {
  const laidDown = events.some((event) => event.type === "worktree");
  const steps = events.filter((event) => event.type === "step").length;
  const paths = useStore(library, (state) => state.pendingTrees[pendingId] ?? null);

  useEffect(() => {
    if (laidDown) void library.getState().loadPendingTree(pendingId);
  }, [library, pendingId, laidDown, steps]);

  if (!laidDown || paths === null) return null;
  return (
    <section
      className="fd-pipeline-tree"
      data-testid={pageTestIds.pipelineTree}
      aria-label="Workspace"
    >
      <h2 className="fd-page-note">Workspace</h2>
      <BuildTree paths={paths} />
    </section>
  );
}

export function BuildPipelinePage({
  pendingId,
  nav,
  library,
  buildProgress,
  terminal,
}: {
  pendingId: string;
  nav: StoreApi<NavState>;
  library: StoreApi<LibraryState>;
  buildProgress: StoreApi<BuildProgressState>;
  terminal: StoreApi<TerminalState>;
}) {
  const entries = useStore(buildProgress, (state) => state.entries);
  const activity = useStore(buildProgress, (state) => state.activity);
  const progress = useStore(buildProgress, (state) => state.progressFor(pendingId));
  const terminalAvailable = useStore(
    terminal,
    (state) => state.runId === pendingId && state.available,
  );
  const [selection, setSelection] = useState<Selection | undefined>(undefined);
  const [tab, setTab] = useState<"log" | "terminal">("log");
  const entry = entries[pendingId];
  const pipeline = useMemo(
    () => selectPipeline(pendingId)({ entries, activity }),
    [pendingId, entries, activity],
  );

  useEffect(() => {
    void buildProgress.getState().viewActivity(pendingId);
    void terminal.getState().view(pendingId);
  }, [buildProgress, terminal, pendingId]);

  if (entry === undefined || pipeline === undefined) return null;
  const open = pipeline.header.status === "building";
  const showTerminal = open && tab === "terminal" && terminalAvailable;
  const selected = selection ?? defaultSelection(pipeline);
  const lane = pipeline.lanes.find((each) => selected !== undefined && sameLane(each, selected));
  const row = lane?.rows.find((each) => each.path === selected?.path);
  const blocked = pipeline.blockedLane;
  const builtId = entry.buildId;
  const questions =
    progress?.questions === undefined ? null : (
      <BuildQuestions
        pendingId={pendingId}
        questions={progress.questions}
        answerable={progress.answerable === true}
        buildProgress={buildProgress}
      />
    );
  const blueprint =
    entry.blueprintName === undefined
      ? undefined
      : `${entry.blueprintName}${entry.blueprintVersion === undefined ? "" : ` v${entry.blueprintVersion}`}`;

  return (
    <section data-testid={pageTestIds.buildProgress(pendingId)} aria-label="Build pipeline">
      <Header
        pendingId={pendingId}
        pipeline={pipeline}
        blueprint={blueprint}
        nav={nav}
        buildProgress={buildProgress}
      />
      {pipeline.header.status === "built" && builtId !== undefined && (
        <p className="fd-page-note">
          <button
            className="fd-link"
            data-testid={pageTestIds.buildBuiltLink(pendingId)}
            onClick={() => nav.getState().go({ name: "builds", buildId: builtId })}
          >
            See the built build {pipeline.header.name}
          </button>
        </p>
      )}
      <BlueprintPicture library={library} pictureKey={{ pendingId }} testId={pendingId} />
      <div className="fd-pipeline">
        <ol className="fd-file-list fd-pipeline-rail" aria-label="Stages">
          {pipeline.lanes.map((each) => (
            <LaneView
              key={`${each.step}-${each.round}`}
              pendingId={pendingId}
              lane={each}
              since={runningSince(entry.events, each)}
              selection={selected}
              onSelect={setSelection}
            >
              {blocked !== undefined && sameLane(each, blocked) && questions}
            </LaneView>
          ))}
          {blocked === undefined && questions !== null && <li>{questions}</li>}
        </ol>
        <div className="fd-pipeline-detail">
          {open && (
            <div className="fd-tabs" role="tablist" aria-label="Build views">
              <button
                className="fd-tab"
                role="tab"
                aria-selected={!showTerminal}
                data-testid={pageTestIds.buildLogTab(pendingId)}
                onClick={() => setTab("log")}
              >
                Log
              </button>
              <button
                className="fd-tab"
                role="tab"
                aria-selected={showTerminal}
                data-testid={pageTestIds.buildTerminal(pendingId)}
                disabled={!terminalAvailable}
                title={terminalAvailable ? undefined : "The build session is not open"}
                onClick={() => setTab("terminal")}
              >
                Terminal
              </button>
            </div>
          )}
          {showTerminal ? (
            <BuildTerminal terminal={terminal} />
          ) : (
            <LogView pendingId={pendingId} lane={lane} row={row} />
          )}
        </div>
      </div>
      <PipelineTree pendingId={pendingId} events={entry.events} library={library} />
    </section>
  );
}
