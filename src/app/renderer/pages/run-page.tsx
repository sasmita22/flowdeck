import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { Actions } from "../actions.js";
import { labelFor } from "../../../core/nodes/defaults.js";
import { InspectorPanel } from "../inspector-panel.js";
import type { FullTextStore } from "../inspector/full-text-store.js";
import type { RunLabels } from "../inspector/inspector.js";
import type { InspectorState } from "../inspector/store.js";
import type { WaitState } from "../inspector/wait-store.js";
import { ItemMenu } from "../item-menu.js";
import { selectBuildCards, type LibraryState } from "../library-store.js";
import { variablesText } from "../../../core/run/digest.js";
import { repoStateText } from "../../../core/run/repo-state.js";
import type { LoadedRun } from "../../../core/run/listing.js";
import { storyPartsOf } from "../../../core/run/story.js";
import { Ask } from "../inspector/ask.js";
import type { NavState } from "../nav-store.js";
import { PanelToggle } from "../panel-toggle.js";
import {
  selectLiveBadge,
  selectRunDisabled,
  selectRunSnapshot,
  type RunState,
  type RunView,
} from "../run-store.js";
import { selectInspectorOpen, type ShellState } from "../shell-store.js";
import type { TerminalState } from "../terminal/store.js";
import { controlTestIds, pageTestIds } from "../test-ids.js";
import { BlueprintPicture } from "./blueprint-picture.js";
import { RunPipeline } from "./pipeline.js";

const tone = {
  running: "live",
  done: "ok",
  failed: "fail",
  stopped: "quiet",
  interrupted: "quiet",
} as const;

type Story = NonNullable<LoadedRun["story"]>;

function StoryAccount({ text }: { text: string }) {
  const parts = storyPartsOf(text);
  if (parts === undefined)
    return (
      <p className="fd-run-reply fd-run-story-account" data-testid={pageTestIds.runStoryAccount}>
        {text}
      </p>
    );
  const blocks = [
    { label: "Context", text: parts.context, testId: pageTestIds.runStoryContext },
    { label: "Goal", text: parts.goal, testId: pageTestIds.runStoryGoal },
    { label: "Result", text: parts.result, testId: pageTestIds.runStoryResult },
  ];
  return (
    <div className="fd-run-story-account" data-testid={pageTestIds.runStoryAccount}>
      {blocks.map((block) => (
        <div key={block.label} data-testid={block.testId}>
          <h3 className="fd-run-detail-heading">{block.label}</h3>
          <p className="fd-run-reply">{block.text}</p>
        </div>
      ))}
    </div>
  );
}

function StoryPanel({
  story,
  runId,
  ended,
  run,
  actions,
}: {
  story: Story;
  runId: string;
  ended: boolean;
  run: StoreApi<RunState>;
  actions: Actions;
}) {
  const { header } = story;
  const writing = useStore(run, (state) => state.writingStory[runId] === true);
  const writeError = useStore(run, (state) => state.storyErrors[runId]);
  const variables = variablesText(header.values);
  const otherRepos = header.otherRepos ?? [];
  const [digestOpen, setDigestOpen] = useState(false);
  return (
    <section className="fd-card fd-run-story" data-testid={pageTestIds.runStory}>
      <div className="fd-card-meta" data-testid={pageTestIds.runStoryHeader}>
        {header.name !== null && <strong>{header.name}</strong>}
        {header.blueprintName !== null && (
          <span>
            {header.blueprintName}
            {header.blueprintVersion === null ? "" : ` v${header.blueprintVersion}`}
          </span>
        )}
        {header.repo !== null && <code className="fd-hash">{header.repo}</code>}
        {header.branch != null && <code className="fd-hash">{header.branch}</code>}
        {variables !== "" && <span>{variables}</span>}
        {otherRepos.length > 0 && (
          <div className="fd-run-story-other-repos">
            <span>Other repos</span>
            <ul data-testid={pageTestIds.runStoryOtherRepos}>
              {otherRepos.map((other) => (
                <li key={other.path}>
                  <code className="fd-hash">{`${other.path} · ${other.branch}`}</code>
                  {(other.before !== undefined || other.after !== undefined) && (
                    <>
                      <div>{`Before: ${repoStateText(other.before ?? null)}`}</div>
                      <div>{`After: ${repoStateText(other.after ?? null)}`}</div>
                    </>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      {story.written !== null && <StoryAccount text={story.written.text} />}
      {ended && story.written === null && (
        <button
          className="fd-btn fd-btn-primary fd-run-story-toggle"
          data-testid={pageTestIds.runStoryWrite}
          disabled={writing}
          onClick={() => void actions.writeStory(runId)}
        >
          {writing ? "Writing story…" : "Write story"}
        </button>
      )}
      {story.written === null && writeError !== undefined && (
        <p className="fd-page-note" data-testid={pageTestIds.runStoryWriteError} role="alert">
          {writeError}
        </p>
      )}
      <button
        className="fd-btn fd-run-story-toggle"
        data-testid={pageTestIds.runStoryDigestToggle}
        aria-expanded={digestOpen}
        onClick={() => setDigestOpen(!digestOpen)}
      >
        Digest
      </button>
      {digestOpen && (
        <pre className="fd-file-content" data-testid={pageTestIds.runStoryDigest} tabIndex={0}>
          {story.digest}
        </pre>
      )}
    </section>
  );
}

export function RunPage({
  runId,
  nav,
  library,
  run,
  shell,
  inspector,
  wait,
  terminal,
  actions,
  fullText,
}: {
  runId: string;
  nav: StoreApi<NavState>;
  library: StoreApi<LibraryState>;
  run: StoreApi<RunState>;
  shell: StoreApi<ShellState>;
  inspector: StoreApi<InspectorState>;
  wait: StoreApi<WaitState>;
  terminal: StoreApi<TerminalState>;
  actions: Actions;
  fullText: FullTextStore;
}) {
  const loaded = useStore(library, (state) =>
    state.viewedRun?.run.id === runId ? state.viewedRun : null,
  );
  const live = useStore(run, (state) => selectRunSnapshot(state, runId));
  const buildId = loaded?.run.buildId;
  const builds = useStore(library, (state) => state.builds);
  const runs = useStore(library, (state) => state.runs);
  const card = selectBuildCards({ builds, runs }).find((build) => build.id === buildId);
  const starting = useStore(run, (state) => state.starting);

  useEffect(() => {
    void library.getState().openRun(runId);
    void run.getState().view(runId);
    void terminal.getState().view(runId);
    void inspector.getState().view(runId);
    void wait.getState().view(runId);
  }, [library, run, terminal, inspector, wait, runId]);

  const liveStatus = live?.status;
  const wasRunning = useRef(false);
  useEffect(() => {
    if (liveStatus === "running") wasRunning.current = true;
    else if (liveStatus !== undefined && wasRunning.current) {
      wasRunning.current = false;
      void library.getState().openRun(runId);
    }
  }, [library, runId, liveStatus]);

  const stages = loaded?.stages ?? null;
  const labels = useMemo<RunLabels>(
    () => ({
      sessionName: stages?.session.name ?? "",
      nodes: (stages?.nodes ?? []).map((node) => ({ id: node.id, label: labelFor(node) })),
    }),
    [stages],
  );

  const snapshot = live ?? loaded?.snapshot ?? null;
  const view = useMemo(() => createStore<RunView>()(() => ({ snapshot: null })), []);
  useEffect(() => {
    view.setState({ snapshot });
  }, [view, snapshot]);
  const status = snapshot?.status ?? "running";
  const blocked = useStore(run, (state) =>
    selectRunDisabled(state, card ?? { old: false, run: { id: runId, status } }),
  );
  const badge = (live === null ? null : selectLiveBadge(live)) ?? status;
  const waiting = useStore(wait, (state) => state.pending !== null);
  const inspectorOpen = useStore(shell, (state) => selectInspectorOpen(state, { snapshot }));
  const gone = loaded?.run.buildGone === true;
  const canGoOn = !gone && !starting && (status === "stopped" || status === "interrupted");
  const canRetry = !gone && !starting && status !== "running";
  const selectNode = (nodeId: string) => run.getState().selectStage(runId, { nodeId });
  const page =
    loaded === null
      ? undefined
      : {
          runId,
          run,
          terminal,
          stored: loaded.activity,
          canRetry,
        };

  return (
    <>
      <header className="fd-title-row">
        <nav className="fd-crumbs" aria-label="Breadcrumb">
          <button
            className="fd-crumb"
            data-testid={pageTestIds.runBack}
            onClick={() => nav.getState().go({ name: "runs" })}
          >
            Runs
          </button>
          <span aria-hidden="true">/</span>
          <span className="fd-flow-title" data-testid={pageTestIds.title}>
            {loaded?.name ?? "Run"}
            {loaded === null || loaded.run.blueprintVersion === null
              ? ""
              : ` v${loaded.run.blueprintVersion}`}
          </span>
          {buildId !== undefined && !gone && loaded !== null && loaded.run.buildName !== null && (
            <button
              className="fd-crumb fd-hash"
              data-testid={pageTestIds.runBuildTag}
              title="Open this run's build"
              onClick={() => nav.getState().go({ name: "builds", buildId })}
            >
              {loaded.run.buildName}
            </button>
          )}
        </nav>
        <span
          className={`fd-badge fd-badge-${badge === "needs you" ? "warn" : tone[status]}`}
          data-testid={pageTestIds.runPageStatus}
          data-status={status}
        >
          {badge}
        </span>
        <div className="fd-title-actions">
          {live?.status === "running" && (
            <button
              className="fd-btn"
              data-testid={pageTestIds.runStop}
              title="Stop the session and mark the run stopped; the working folder is kept"
              onClick={() => void run.getState().stop(runId)}
            >
              Stop
            </button>
          )}
          {canGoOn && (
            <button
              className="fd-btn"
              data-testid={pageTestIds.runResume}
              title="Carry on from where the run stopped, without redoing finished nodes"
              onClick={() => void run.getState().resume(runId)}
            >
              Resume
            </button>
          )}
          {buildId !== undefined && !gone && (
            <button
              className="fd-btn fd-btn-primary"
              data-testid={pageTestIds.runAgain}
              disabled={blocked}
              title="Run the same build again"
              onClick={() => void actions.runBuild(buildId)}
            >
              Run again
            </button>
          )}
          {loaded !== null && !inspectorOpen && (
            <PanelToggle
              side="right"
              label="Show inspector"
              testId={controlTestIds.inspectorShow}
              shell={shell}
              onClick={() => shell.getState().toggleInspector(view.getState())}
            />
          )}
          <ItemMenu
            run={run}
            menuKey={`run-page:${runId}`}
            triggerTestId={pageTestIds.runPageMenu}
            label="Run actions"
            items={[
              {
                testId: pageTestIds.runPageDelete,
                label: "Delete",
                onSelect: () =>
                  void run.getState().askDelete({ kind: "run", id: runId, from: "run-page" }),
              },
            ]}
          />
        </div>
      </header>
      {buildId !== undefined && (
        <BlueprintPicture library={library} pictureKey={{ buildId }} testId={buildId} />
      )}
      <div className="fd-main" style={{ position: "relative" }}>
        {live !== null && waiting && !inspectorOpen && (
          <div className="fd-wait-banner" data-testid="wait-banner">
            <Ask wait={wait} />
          </div>
        )}
        <div className="fd-run-stages">
          {status === "interrupted" && loaded?.note !== undefined && (
            <p className="fd-run-note" data-testid={pageTestIds.runPageNote} role="status">
              {loaded.note}
            </p>
          )}
          {loaded?.story !== undefined && (
            <StoryPanel
              story={loaded.story}
              runId={runId}
              ended={status === "done" || status === "failed" || status === "stopped"}
              run={run}
              actions={actions}
            />
          )}
          {loaded !== null && (
            <RunPipeline
              runId={runId}
              recorded={stages !== null}
              run={run}
              view={view}
              inspector={inspector}
              stored={loaded.activity}
              labels={labels}
              canRetry={canRetry}
              fullText={{ ownerId: runId, store: fullText }}
            />
          )}
        </div>
        {loaded !== null && (
          <InspectorPanel
            shell={shell}
            run={view}
            labels={labels}
            onSelectNode={selectNode}
            inspector={inspector}
            wait={live === null ? undefined : wait}
            readOnly
            page={page}
          />
        )}
      </div>
    </>
  );
}
