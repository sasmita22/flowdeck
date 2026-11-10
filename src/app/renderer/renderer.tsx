import { createRoot } from "react-dom/client";
import { createActions } from "./actions.js";
import { App } from "./app.js";
import { createAssistantStore } from "./assistant/assistant-store.js";
import { createToolHandler } from "./assistant/tool-handler.js";
import { createBranchStore } from "./branch-store.js";
import { createBuildProgressStore } from "./build-progress-store.js";
import { createAppStore } from "./app-store.js";
import { createCanvasStore } from "./canvas/store.js";
import { createInspectorStore } from "./inspector/store.js";
import { createLibraryStore } from "./library-store.js";
import { createNavStore } from "./nav-store.js";
import { createWaitStore } from "./inspector/wait-store.js";
import { createRunStore, needsSessionSetup } from "./run-store.js";
import { createSaveStore } from "./save-store.js";
import { createShellStore } from "./shell-store.js";
import { createTerminalStore } from "./terminal/store.js";
import { TerminalWindow } from "./terminal/terminal-pane.js";
import { createWorkspaceStore } from "./workspace-store.js";
import "./theme.css";

const browserStorage = () => {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
};

function renderTerminalWindow(root: HTMLElement, runId: string) {
  document.title = "Flowdeck terminal";
  const terminal = createTerminalStore({ bridge: window.flowdeck });
  void terminal.getState().connect();
  void terminal.getState().view(runId);
  createRoot(root).render(<TerminalWindow store={terminal} />);
}

function renderApp(root: HTMLElement) {
  const store = createAppStore(window.flowdeck);
  void store.getState().load();
  const canvas = createCanvasStore({ ready: false });
  const save = createSaveStore({ bridge: window.flowdeck, canvas });
  void save.getState().open();
  const run = createRunStore({ bridge: window.flowdeck, save, canvas });
  void run.getState().connect();
  const terminal = createTerminalStore({ bridge: window.flowdeck });
  void terminal.getState().connect();
  const blueprintTerminal = createTerminalStore({ bridge: window.flowdeck });
  void blueprintTerminal.getState().connect();
  const inspector = createInspectorStore({ bridge: window.flowdeck });
  void inspector.getState().connect();
  const wait = createWaitStore({ bridge: window.flowdeck });
  void wait.getState().connect();
  const shell = createShellStore({ canvas, storage: browserStorage() });
  const syncWindowWidth = () => shell.getState().setWindowWidth(window.innerWidth);
  syncWindowWidth();
  window.addEventListener("resize", syncWindowWidth);
  const workspace = createWorkspaceStore({ bridge: window.flowdeck, canvas, save });
  const nav = createNavStore({ leave: (next) => save.getState().leave(next) });
  const library = createLibraryStore({ bridge: window.flowdeck });
  const buildProgress = createBuildProgressStore(window.flowdeck);
  void buildProgress.getState().connect();
  void library.getState().refresh();
  run.subscribe((next, previous) => {
    const moved = Object.values(next.snapshots).some(
      (snapshot) => previous.snapshots[snapshot.runId]?.status !== snapshot.status,
    );
    if (moved) void library.getState().refresh();
  });
  save.subscribe((next, previous) => {
    if (next.version !== previous.version || next.name !== previous.name) {
      void library.getState().refresh();
    }
  });
  run.subscribe((next, previous) => {
    if (next.problems !== previous.problems && needsSessionSetup(next.problems)) {
      shell.getState().openSessionSettings();
    }
  });
  const branches = createBranchStore({ bridge: window.flowdeck });
  const buildBranches = createBranchStore({ bridge: window.flowdeck });
  const assistant = createAssistantStore({ bridge: window.flowdeck, save });
  const actions = createActions({ nav, save, run, library, assistant });
  createToolHandler({ bridge: window.flowdeck, canvas, save, nav });

  createRoot(root).render(
    <App
      store={store}
      canvas={canvas}
      save={save}
      run={run}
      terminal={terminal}
      inspector={inspector}
      wait={wait}
      shell={shell}
      workspace={workspace}
      nav={nav}
      library={library}
      branches={branches}
      buildBranches={buildBranches}
      buildProgress={buildProgress}
      assistant={assistant}
      blueprintTerminal={blueprintTerminal}
      actions={actions}
    />,
  );
}

const root = document.getElementById("root");
if (root === null) throw new Error("index.html has no #root element");
const terminalRun = /^#terminal\/(.+)$/.exec(window.location.hash)?.[1];
if (terminalRun !== undefined) renderTerminalWindow(root, decodeURIComponent(terminalRun));
else renderApp(root);
