import { useCallback } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import type { AppState } from "./app-store.js";
import { Canvas } from "./canvas/canvas.js";
import { selectDirty, type CanvasState } from "./canvas/store.js";
import { RunStoreContext } from "./canvas/status.js";
import { ClosePrompt } from "./close-prompt.js";
import { Inspector } from "./inspector/inspector.js";
import type { InspectorState } from "./inspector/store.js";
import type { WaitState } from "./inspector/wait-store.js";
import { MoreMenu } from "./more-menu.js";
import { selectRunDisabled, selectRunSummary, type RunState } from "./run-store.js";
import type { SaveState } from "./save-store.js";
import { selectInspectorOpen, type ShellState } from "./shell-store.js";
import type { TerminalState } from "./terminal/store.js";
import { TerminalPane } from "./terminal/terminal-pane.js";
import { controlTestIds } from "./test-ids.js";
import { selectWorkspaceLabel, type WorkspaceState } from "./workspace-store.js";

const statusText = (status: AppState["status"]) =>
  status.kind === "error" ? status.message : status.kind;

function TitleRow({
  canvas,
  save,
  run,
  terminal,
  shell,
}: {
  canvas: StoreApi<CanvasState>;
  save: StoreApi<SaveState>;
  run: StoreApi<RunState>;
  terminal: StoreApi<TerminalState>;
  shell: StoreApi<ShellState>;
}) {
  const ready = useStore(canvas, (state) => state.ready);
  const dirty = useStore(canvas, selectDirty);
  const saving = useStore(save, (state) => state.saving);
  const runDisabled = useStore(run, (state) => selectRunDisabled(state, { saving }));
  return (
    <header className="fd-title-row">
      <span className="fd-app-name" data-testid="app-title">
        Flowdeck
      </span>
      <span className="fd-flow-title" data-testid="flow-title">
        Untitled
      </span>
      {ready && dirty && (
        <span className="fd-unsaved" data-testid="flow-unsaved">
          Unsaved
        </span>
      )}
      <div className="fd-title-actions">
        {ready && (
          <button
            className="fd-btn fd-btn-primary"
            data-testid={controlTestIds.save}
            disabled={!dirty || saving}
            onClick={() => void save.getState().save()}
          >
            Save
          </button>
        )}
        {ready && (
          <button
            className="fd-btn fd-btn-primary"
            data-testid={controlTestIds.run}
            disabled={runDisabled}
            onClick={() => void run.getState().run()}
          >
            Run
          </button>
        )}
        {ready && <MoreMenu shell={shell} run={run} terminal={terminal} />}
      </div>
    </header>
  );
}

function Errors({
  canvas,
  save,
  run,
}: {
  canvas: StoreApi<CanvasState>;
  save: StoreApi<SaveState>;
  run: StoreApi<RunState>;
}) {
  const error = useStore(save, (state) => state.error);
  const runError = useStore(run, (state) => state.error);
  const message = useStore(canvas, (state) => state.message);
  if (error === null && runError === null && message === null) return null;
  return (
    <div className="fd-errors" data-testid="app-errors" role="status">
      {error !== null && <span data-testid="flow-error">{error}</span>}
      {runError !== null && <span data-testid="run-error">{runError}</span>}
      {message !== null && <span data-testid="canvas-message">{message}</span>}
    </div>
  );
}

function StatusBar({
  store,
  run,
  workspace,
}: {
  store: StoreApi<AppState>;
  run: StoreApi<RunState>;
  workspace: StoreApi<WorkspaceState>;
}) {
  const version = useStore(store, (state) => state.version ?? state.versionError ?? "");
  const status = useStore(store, (state) => statusText(state.status));
  const summary = useStore(run, selectRunSummary);
  const folder = useStore(workspace, (state) => state.folder);
  const folderState = useStore(workspace, (state) => state.state);
  const label = selectWorkspaceLabel({ folder, state: folderState });
  return (
    <footer className="fd-status-bar">
      <span data-testid="run-status">{summary}</span>
      {label !== null && (
        <>
          <span
            className="fd-workspace"
            data-testid="workspace-folder"
            title={label.folder.title || undefined}
          >
            {label.folder.name}
          </span>
          <span
            className="fd-workspace"
            data-testid="workspace-branch"
            title={label.branch || undefined}
          >
            {label.branch}
          </span>
        </>
      )}
      <span className="fd-status-right">
        <span data-testid="store-status">{status}</span>
        <span data-testid="app-version">{version}</span>
      </span>
    </footer>
  );
}

export function App({
  store,
  canvas,
  save,
  run,
  terminal,
  inspector,
  wait,
  shell,
  workspace,
}: {
  store: StoreApi<AppState>;
  canvas: StoreApi<CanvasState>;
  save: StoreApi<SaveState>;
  run: StoreApi<RunState>;
  terminal: StoreApi<TerminalState>;
  inspector: StoreApi<InspectorState>;
  wait: StoreApi<WaitState>;
  shell: StoreApi<ShellState>;
  workspace: StoreApi<WorkspaceState>;
}) {
  const ready = useStore(canvas, (state) => state.ready);
  const terminalVisible = useStore(terminal, (state) => state.visible);
  const inspectorShown = useStore(shell, (state) => state.inspectorShown);
  const snapshot = useStore(run, (state) => state.snapshot);
  const inspectorOpen = selectInspectorOpen({ inspectorShown }, { snapshot });
  const onSave = useCallback(() => void save.getState().save(), [save]);
  return (
    <main className="fd-shell">
      <TitleRow canvas={canvas} save={save} run={run} terminal={terminal} shell={shell} />
      <Errors canvas={canvas} save={save} run={run} />
      <div className="fd-main">
        <RunStoreContext.Provider value={run}>
          {ready && <Canvas store={canvas} shell={shell} onSave={onSave} />}
        </RunStoreContext.Provider>
        {ready && inspectorOpen && (
          <div className="fd-inspector">
            <Inspector inspector={inspector} run={run} canvas={canvas} wait={wait} />
          </div>
        )}
      </div>
      {terminalVisible && (
        <section className="fd-terminal" aria-label="Terminal">
          <TerminalPane store={terminal} />
        </section>
      )}
      <StatusBar store={store} run={run} workspace={workspace} />
      <ClosePrompt store={save} />
    </main>
  );
}
