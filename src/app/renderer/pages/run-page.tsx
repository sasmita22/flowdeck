import { useEffect, useMemo } from "react";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { Actions } from "../actions.js";
import { labelFor } from "../canvas/store.js";
import { InspectorPanel } from "../inspector-panel.js";
import type { RunLabels } from "../inspector/inspector.js";
import type { InspectorState } from "../inspector/store.js";
import type { WaitState } from "../inspector/wait-store.js";
import { selectBuildCards, type LibraryState } from "../library-store.js";
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
  const canGoOn = !starting && (status === "stopped" || status === "interrupted");
  const canRetry = !starting && status !== "running";
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
          {card !== undefined && <code className="fd-hash">{card.name}</code>}
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
          {buildId !== undefined && (
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
        </div>
      </header>
      {buildId !== undefined && (
        <BlueprintPicture library={library} pictureKey={{ buildId }} testId={buildId} />
      )}
      <div className="fd-main" style={{ position: "relative" }}>
        {status === "interrupted" && loaded?.note !== undefined && (
          <p className="fd-run-note" data-testid={pageTestIds.runPageNote} role="status">
            {loaded.note}
          </p>
        )}
        {live !== null && waiting && !inspectorOpen && (
          <div className="fd-wait-banner" data-testid="wait-banner">
            <Ask wait={wait} />
          </div>
        )}
        <div className="fd-run-stages">
          {loaded !== null && (
            <RunPipeline
              runId={runId}
              recorded={stages !== null}
              run={run}
              view={view}
              inspector={inspector}
              labels={labels}
              canRetry={canRetry}
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
