import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import type { AppState } from "./app-store.js";
import { Canvas } from "./canvas/canvas.js";
import type { CanvasState } from "./canvas/store.js";

const statusText = (status: AppState["status"]) =>
  status.kind === "error" ? status.message : status.kind;

export function App({
  store,
  canvas,
}: {
  store: StoreApi<AppState>;
  canvas: StoreApi<CanvasState>;
}) {
  const version = useStore(store, (state) => state.version ?? state.versionError ?? "");
  const status = useStore(store, (state) => statusText(state.status));
  return (
    <main>
      <h1 data-testid="app-title">Flowdeck</h1>
      <p data-testid="app-version">{version}</p>
      <p data-testid="store-status">{status}</p>
      <Canvas store={canvas} />
    </main>
  );
}
