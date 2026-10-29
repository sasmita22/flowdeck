import { createRoot } from "react-dom/client";
import { App } from "./app.js";
import { createAppStore } from "./app-store.js";
import { createCanvasStore } from "./canvas/store.js";

const store = createAppStore(window.flowdeck);
void store.getState().load();
const canvas = createCanvasStore();

const root = document.getElementById("root");
if (root === null) throw new Error("index.html has no #root element");
createRoot(root).render(<App store={store} canvas={canvas} />);
