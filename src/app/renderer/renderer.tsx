import { createRoot } from "react-dom/client";
import { App } from "./app.js";
import { createAppStore } from "./app-store.js";
import { createCanvasStore } from "./canvas/store.js";
import { createSaveStore } from "./save-store.js";

const store = createAppStore(window.flowdeck);
void store.getState().load();
const canvas = createCanvasStore({ ready: false });
const save = createSaveStore({ bridge: window.flowdeck, canvas });
void save.getState().open();

const root = document.getElementById("root");
if (root === null) throw new Error("index.html has no #root element");
createRoot(root).render(<App store={store} canvas={canvas} save={save} />);
