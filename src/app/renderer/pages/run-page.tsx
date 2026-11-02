import { useEffect, useMemo } from "react";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { Actions } from "../actions.js";
import { Canvas } from "../canvas/canvas.js";
import { RunStoreContext } from "../canvas/status.js";
import { createCanvasStore } from "../canvas/store.js";
import { shortHash } from "../format.js";
import { InspectorPanel } from "../inspector-panel.js";
import type { InspectorState } from "../inspector/store.js";
import type { WaitState } from "../inspector/wait-store.js";
import type { LibraryState } from "../library-store.js";
import { MoreMenu } from "../more-menu.js";
import type { NavState } from "../nav-store.js";
import { selectLiveBadge, selectRunDisabled, type RunState, type RunView } from "../run-store.js";
import type { SaveState } from "../save-store.js";
import type { ShellState } from "../shell-store.js";
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
  save,
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
  save: StoreApi<SaveState>;
  shell: StoreApi<ShellState>;
  inspector: StoreApi<InspectorState>;
  wait: StoreApi<WaitState>;
  terminal: StoreApi<TerminalState>;
  actions: Actions;
}) {
  const loaded = useStore(library, (state) =>
    state.viewedRun?.run.id === runId ? state.viewedRun : null,
  );
  const live = useStore(run, (state) => (state.snapshot?.runId === runId ? state.snapshot : null));
  const starting = useStore(run, (state) => state.starting);
  const anySnapshot = useStore(run, (state) => state.snapshot);
  const saving = useStore(save, (state) => state.saving);
  const blocked = selectRunDisabled({ starting, snapshot: anySnapshot }, { saving });

  useEffect(() => {
    void library.getState().openRun(runId);
  }, [library, runId]);

  const runCanvas = useMemo(() => {
    const store = createCanvasStore();
    if (loaded?.flow) store.getState().load(loaded.flow);
    return store;
  }, [loaded]);

  const saved = useMemo(
    () => createStore<RunView>()(() => ({ snapshot: loaded?.snapshot ?? null })),
    [loaded],
  );
  const view: StoreApi<RunView> = live === null ? saved : run;
  const snapshot = live ?? loaded?.snapshot ?? null;
  const status = snapshot?.status ?? "running";
  const badge = (live === null ? null : selectLiveBadge(live)) ?? status;
  const flowId = loaded?.run.source?.flowId;
  const hash = loaded?.run.buildHash;

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
          {hash !== undefined && <code className="fd-hash">{shortHash(hash)}</code>}
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
          {hash !== undefined && (
            <button
              className="fd-btn fd-btn-primary"
              data-testid={pageTestIds.runAgain}
              disabled={blocked}
              title="Run the same build again"
              onClick={() => void actions.runBuild(hash)}
            >
              Run again
            </button>
          )}
          {live !== null && <MoreMenu shell={shell} terminal={terminal} />}
        </div>
      </header>
      <div className="fd-main">
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
          />
        )}
      </div>
    </>
  );
}
