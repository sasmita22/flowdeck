import { useEffect, useMemo } from "react";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { Actions } from "../actions.js";
import { Canvas } from "../canvas/canvas.js";
import { RunStoreContext } from "../canvas/status.js";
import { createCanvasStore } from "../canvas/store.js";
import { InspectorPanel } from "../inspector-panel.js";
import type { InspectorState } from "../inspector/store.js";
import type { WaitState } from "../inspector/wait-store.js";
import { selectBuildCards, type LibraryState } from "../library-store.js";
import { Ask } from "../inspector/ask.js";
import type { NavState } from "../nav-store.js";
import {
  selectLiveBadge,
  selectRunDisabled,
  selectRunSnapshot,
  type RunState,
  type RunView,
} from "../run-store.js";
import { selectInspectorOpen, type ShellState } from "../shell-store.js";
import type { TerminalState } from "../terminal/store.js";
import { pageTestIds } from "../test-ids.js";

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
  const flows = useStore(library, (state) => state.flows);
  const builds = useStore(library, (state) => state.builds);
  const runs = useStore(library, (state) => state.runs);
  const card = selectBuildCards({ flows, builds, runs }).find((build) => build.id === buildId);
  const starting = useStore(run, (state) => state.starting);

  useEffect(() => {
    void library.getState().openRun(runId);
    void run.getState().view(runId);
    void terminal.getState().view(runId);
    void inspector.getState().view(runId);
    void wait.getState().view(runId);
  }, [library, run, terminal, inspector, wait, runId]);

  const runCanvas = useMemo(() => {
    const store = createCanvasStore();
    if (loaded?.flow) store.getState().load(loaded.flow);
    return store;
  }, [loaded]);

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
  const flowId = loaded?.run.source?.flowId;
  const waiting = useStore(wait, (state) => state.pending !== null);
  const inspectorOpen = useStore(shell, (state) => selectInspectorOpen(state, { snapshot }));
  const canGoOn = !starting && (status === "stopped" || status === "interrupted");
  const page =
    loaded === null
      ? undefined
      : {
          runId,
          run,
          terminal,
          stored: loaded.activity,
          canRetry: !starting && status !== "running",
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
            {loaded?.run.source === undefined ? "" : ` v${loaded.run.source.version}`}
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
          {flowId !== undefined && (
            <button
              className="fd-btn"
              data-testid={pageTestIds.runOpenBlueprint}
              onClick={() => void actions.openBlueprint(flowId)}
            >
              Open blueprint
            </button>
          )}
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
        </div>
      </header>
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
        {loaded !== null && loaded.flow !== null ? (
          <RunStoreContext.Provider value={view}>
            <Canvas store={runCanvas} shell={shell} run={view} readOnly />
          </RunStoreContext.Provider>
        ) : (
          <div className="fd-canvas fd-canvas-empty" data-testid="canvas">
            {loaded !== null && (
              <p className="fd-empty">This run's build was not made from a saved blueprint.</p>
            )}
          </div>
        )}
        {loaded !== null && (
          <InspectorPanel
            shell={shell}
            run={view}
            canvas={runCanvas}
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
