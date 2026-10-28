import { createRoot } from "react-dom/client";
import { App } from "./app.js";
import { createAppStore } from "./app-store.js";

const store = createAppStore(window.flowdeck);
void store.getState().load();

const root = document.getElementById("root");
if (root === null) throw new Error("index.html has no #root element");
createRoot(root).render(<App store={store} />);
