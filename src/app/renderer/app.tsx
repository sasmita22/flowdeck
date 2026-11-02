import { useEffect } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import type { Actions } from "./actions.js";
import { AppMenu } from "./app-menu.js";
import type { AppState } from "./app-store.js";
import type { CanvasState } from "./canvas/store.js";
import { ClosePrompt } from "./close-prompt.js";
import type { InspectorState } from "./inspector/store.js";
import type { WaitState } from "./inspector/wait-store.js";
import { LeavePrompt } from "./leave-prompt.js";
import type { LibraryState } from "./library-store.js";
import type { NavState, Page } from "./nav-store.js";
import { BlueprintsPage } from "./pages/blueprints-page.js";
import { BuildsPage } from "./pages/builds-page.js";
import { DoctorPage } from "./pages/doctor-page.js";
import { EditorPage } from "./pages/editor-page.js";
import { RunPage } from "./pages/run-page.js";
import { RunsPage } from "./pages/runs-page.js";
import { RunDialog } from "./run-dialog.js";
import { selectRunSummary, type RunState } from "./run-store.js";
import type { SaveState } from "./save-store.js";
import type { ShellState } from "./shell-store.js";
import type { TerminalState } from "./terminal/store.js";
import { TerminalPane } from "./terminal/terminal-pane.js";
import { selectWorkspaceLabel, type WorkspaceState } from "./workspace-store.js";

const statusText = (status: AppState["status"]) =>
  status.kind === "error" ? status.message : status.kind;

export type AppStores = {
  store: StoreApi<AppState>;
  canvas: StoreApi<CanvasState>;
  save: StoreApi<SaveState>;
  run: StoreApi<RunState>;
  terminal: StoreApi<TerminalState>;
  inspector: StoreApi<InspectorState>;
  wait: StoreApi<WaitState>;
  shell: StoreApi<ShellState>;
  workspace: StoreApi<WorkspaceState>;
  nav: StoreApi<NavState>;
  library: StoreApi<LibraryState>;
  actions: Actions;
};

function Errors({ canvas, save, run, library }: AppStores) {
  const error = useStore(save, (state) => state.error);
  const runError = useStore(run, (state) => state.error);
  const message = useStore(canvas, (state) => state.message);
  const libraryError = useStore(library, (state) => state.error);
  if (error === null && runError === null && message === null && libraryError === null) {
    return null;
  }
  return (
    <div className="fd-errors" data-testid="app-errors" role="status">
      {error !== null && <span data-testid="flow-error">{error}</span>}
      {runError !== null && <span data-testid="run-error">{runError}</span>}
      {message !== null && <span data-testid="canvas-message">{message}</span>}
      {libraryError !== null && <span data-testid="library-error">{libraryError}</span>}
    </div>
  );
}

function RunSummary({ run, nav, wait }: Pick<AppStores, "run" | "nav" | "wait">) {
  const waiting = useStore(wait, (state) => state.pending !== null);
  const summary = useStore(run, (state) => selectRunSummary(state, waiting));
  const liveRunId = useStore(run, (state) =>
    state.snapshot?.status === "running" ? state.snapshot.runId : null,
  );
  if (liveRunId === null) return <span data-testid="run-status">{summary}</span>;
  return (
    <button
      className="fd-link"
      data-testid="run-status"
      title="Open the live run"
      onClick={() => nav.getState().go({ name: "run", runId: liveRunId })}
    >
      {summary}
    </button>
  );
}

function StatusBar({ store, run, workspace, nav, wait }: AppStores) {
  const version = useStore(store, (state) => state.version ?? state.versionError ?? "");
  const status = useStore(store, (state) => statusText(state.status));
  const folder = useStore(workspace, (state) => state.folder);
  const folderState = useStore(workspace, (state) => state.state);
  const label = selectWorkspaceLabel({ folder, state: folderState });
  return (
    <footer className="fd-status-bar">
      <RunSummary run={run} nav={nav} wait={wait} />
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

function ListPage({ page, stores }: { page: Page; stores: AppStores }) {
  const { nav, library, run, save, canvas, actions } = stores;
  switch (page.name) {
    case "blueprints":
      return <BlueprintsPage nav={nav} library={library} run={run} actions={actions} />;
    case "builds":
      return (
        <BuildsPage
          hash={page.hash}
          nav={nav}
          library={library}
          run={run}
          save={save}
          actions={actions}
        />
      );
    case "runs":
      return <RunsPage nav={nav} library={library} run={run} />;
    case "doctor":
      return <DoctorPage nav={nav} library={library} save={save} canvas={canvas} />;
    default:
      return null;
  }
}

function Library({ page, stores }: { page: Page; stores: AppStores }) {
  const { nav, library, run, actions } = stores;
  useEffect(() => {
    void library.getState().refresh();
  }, [library, page]);
  return (
    <div className="fd-library">
      <AppMenu nav={nav} library={library} run={run} actions={actions} />
      <section className="fd-page" aria-label="Page">
        <div className="fd-page-inner">
          <ListPage page={page} stores={stores} />
        </div>
      </section>
    </div>
  );
}

function Page({ page, stores }: { page: Page; stores: AppStores }) {
  if (page.name === "editor") {
    return (
      <EditorPage
        canvas={stores.canvas}
        save={stores.save}
        run={stores.run}
        terminal={stores.terminal}
        inspector={stores.inspector}
        shell={stores.shell}
        nav={stores.nav}
        actions={stores.actions}
      />
    );
  }
  if (page.name === "run") {
    return (
      <RunPage
        runId={page.runId}
        nav={stores.nav}
        library={stores.library}
        run={stores.run}
        save={stores.save}
        shell={stores.shell}
        inspector={stores.inspector}
        wait={stores.wait}
        terminal={stores.terminal}
        actions={stores.actions}
      />
    );
  }
  return <Library page={page} stores={stores} />;
}

export function App(stores: AppStores) {
  const page = useStore(stores.nav, (state) => state.page);
  const terminalVisible = useStore(stores.terminal, (state) => state.visible);
  return (
    <main className="fd-shell" data-page={page.name}>
      <Page page={page} stores={stores} />
      <Errors {...stores} />
      {terminalVisible && (
        <section className="fd-terminal" aria-label="Terminal">
          <TerminalPane store={stores.terminal} />
        </section>
      )}
      <StatusBar {...stores} />
      <RunDialog run={stores.run} actions={stores.actions} />
      <ClosePrompt store={stores.save} />
      <LeavePrompt store={stores.save} />
    </main>
  );
}
