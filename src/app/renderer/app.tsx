import { useEffect } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import type { Actions } from "./actions.js";
import { AppMenu } from "./app-menu.js";
import { BuildDialog } from "./build-dialog.js";
import type { AppState } from "./app-store.js";
import type { AssistantState } from "./assistant/assistant-store.js";
import type { BranchState } from "./branch-store.js";
import type { BuildProgressState } from "./build-progress-store.js";
import { nodeLabel, type CanvasState } from "./canvas/store.js";
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
import { selectLatestSnapshot, selectRunSummary, type RunState } from "./run-store.js";
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
  branches: StoreApi<BranchState>;
  buildBranches: StoreApi<BranchState>;
  buildProgress: StoreApi<BuildProgressState>;
  assistant: StoreApi<AssistantState>;
  blueprintTerminal: StoreApi<TerminalState>;
  actions: Actions;
};

function Problems({
  canvas,
  run,
  shell,
  nav,
}: Pick<AppStores, "canvas" | "run" | "shell" | "nav">) {
  const problems = useStore(run, (state) => state.problems);
  const nodes = useStore(canvas, (state) => state.flow.nodes);
  if (problems === null) return null;
  const open = (node: string | undefined) => {
    nav.getState().go({ name: "editor" });
    if (node === undefined) shell.getState().openSessionSettings();
    else {
      canvas.getState().focusNode(node);
      shell.getState().showInspector();
    }
  };
  const count = problems.length === 1 ? "1 problem" : `${problems.length} problems`;
  return (
    <section className="fd-problems" data-testid="build-problems" aria-label="Build problems">
      <div className="fd-problems-head">
        <strong>Can't build yet: {count} to fix</strong>
        <button
          className="fd-btn"
          data-testid="build-problems-dismiss"
          onClick={() => run.getState().dismissProblems()}
        >
          Dismiss
        </button>
      </div>
      <ul className="fd-problems-list">
        {problems.map(({ node, text }, index) => (
          <li key={`${node ?? "session"}-${index}`}>
            <button
              className="fd-problem"
              data-testid={`build-problem-${index}`}
              data-node={node}
              title={node === undefined ? "Open the session settings" : "Select this node"}
              onClick={() => open(node)}
            >
              <span className="fd-problem-where">
                {node === undefined ? "Session" : nodeLabel(nodes, node)}
              </span>
              <span>{text}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Errors(stores: AppStores) {
  const { save, run, library } = stores;
  const error = useStore(save, (state) => state.error);
  const runError = useStore(run, (state) => state.error);
  const problems = useStore(run, (state) => state.problems);
  const libraryError = useStore(library, (state) => state.error);
  if (error === null && runError === null && problems === null && libraryError === null) {
    return null;
  }
  return (
    <div className="fd-errors" data-testid="app-errors" role="status">
      {error !== null && <span data-testid="flow-error">{error}</span>}
      {runError !== null && <span data-testid="run-error">{runError}</span>}
      <Problems {...stores} />
      {libraryError !== null && <span data-testid="library-error">{libraryError}</span>}
    </div>
  );
}

function RunSummary({ run, nav, wait }: Pick<AppStores, "run" | "nav" | "wait">) {
  const waiting = useStore(wait, (state) => state.pending !== null);
  const summary = useStore(run, (state) =>
    selectRunSummary({ snapshot: selectLatestSnapshot(state) }, waiting),
  );
  const liveRunId = useStore(run, (state) => {
    const latest = selectLatestSnapshot(state);
    return latest?.status === "running" ? latest.runId : null;
  });
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
  const info = useStore(workspace, (state) => state.info);
  const label = selectWorkspaceLabel({ folder, info });
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
  const { nav, library, run, save, canvas, buildProgress, terminal, actions } = stores;
  switch (page.name) {
    case "blueprints":
      return (
        <BlueprintsPage
          nav={nav}
          library={library}
          run={run}
          buildProgress={buildProgress}
          actions={actions}
        />
      );
    case "builds":
      return (
        <BuildsPage
          buildId={page.buildId}
          nav={nav}
          library={library}
          run={run}
          buildProgress={buildProgress}
          terminal={terminal}
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
        branches={stores.branches}
        buildProgress={stores.buildProgress}
        assistant={stores.assistant}
        blueprintTerminal={stores.blueprintTerminal}
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
      <BuildDialog
        run={stores.run}
        nav={stores.nav}
        library={stores.library}
        branches={stores.buildBranches}
      />
      <RunDialog run={stores.run} actions={stores.actions} />
      <ClosePrompt store={stores.save} />
      <LeavePrompt store={stores.save} />
    </main>
  );
}
