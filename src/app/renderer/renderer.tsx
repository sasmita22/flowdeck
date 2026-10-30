import { createRoot } from "react-dom/client";
import { App } from "./app.js";
import { createAppStore } from "./app-store.js";
import { createCanvasStore } from "./canvas/store.js";
import { createInspectorStore } from "./inspector/store.js";
import { createWaitStore } from "./inspector/wait-store.js";
import { createRunStore } from "./run-store.js";
import { createSaveStore } from "./save-store.js";
import { createTerminalStore } from "./terminal/store.js";

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

const root = document.getElementById("root");
if (root === null) throw new Error("index.html has no #root element");
createRoot(root).render(
  <App
    store={store}
    canvas={canvas}
    save={save}
    run={run}
    terminal={terminal}
    inspector={inspector}
    wait={wait}
  />,
);
