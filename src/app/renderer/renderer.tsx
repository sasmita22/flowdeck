import { createRoot } from "react-dom/client";
import { createActions } from "./actions.js";
import { App } from "./app.js";
import { createAppStore } from "./app-store.js";
import { createCanvasStore } from "./canvas/store.js";
import { createInspectorStore } from "./inspector/store.js";
import { createLibraryStore } from "./library-store.js";
import { createNavStore } from "./nav-store.js";
import { createWaitStore } from "./inspector/wait-store.js";
import { createRunStore } from "./run-store.js";
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

function renderTerminalWindow(root: HTMLElement) {
  document.title = "Flowdeck terminal";
  const terminal = createTerminalStore({ bridge: window.flowdeck });
  void terminal.getState().connect();
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
  const inspector = createInspectorStore({ bridge: window.flowdeck });
  void inspector.getState().connect();
  const wait = createWaitStore({ bridge: window.flowdeck });
  void wait.getState().connect();
  const shell = createShellStore({ canvas, storage: browserStorage() });
  const syncWindowWidth = () => shell.getState().setWindowWidth(window.innerWidth);
  syncWindowWidth();
  window.addEventListener("resize", syncWindowWidth);
  const workspace = createWorkspaceStore({ bridge: window.flowdeck, canvas, save, run });
  const nav = createNavStore();
  const library = createLibraryStore({ bridge: window.flowdeck });
  void library.getState().refresh();
  run.subscribe((next, previous) => {
    if (next.snapshot?.status !== previous.snapshot?.status) void library.getState().refresh();
  });
  save.subscribe((next, previous) => {
    if (next.version !== previous.version || next.name !== previous.name) {
      void library.getState().refresh();
    }
  });
  const actions = createActions({ nav, save, run, library });

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
      actions={actions}
    />,
  );
}

const root = document.getElementById("root");
if (root === null) throw new Error("index.html has no #root element");
if (window.location.hash === "#terminal") renderTerminalWindow(root);
else renderApp(root);
