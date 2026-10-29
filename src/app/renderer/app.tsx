import { useCallback } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import type { AppState } from "./app-store.js";
import { Canvas } from "./canvas/canvas.js";
import { selectDirty, type CanvasState } from "./canvas/store.js";
import { ClosePrompt } from "./close-prompt.js";
import type { SaveState } from "./save-store.js";

const statusText = (status: AppState["status"]) =>
  status.kind === "error" ? status.message : status.kind;

function TitleStrip({
  canvas,
  save,
}: {
  canvas: StoreApi<CanvasState>;
  save: StoreApi<SaveState>;
}) {
  const ready = useStore(canvas, (state) => state.ready);
  const dirty = useStore(canvas, selectDirty);
  const saving = useStore(save, (state) => state.saving);
  const error = useStore(save, (state) => state.error);
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "baseline", marginBottom: 8 }}>
      <span data-testid="flow-title">Untitled</span>
      {ready && dirty && <span data-testid="flow-unsaved">Unsaved</span>}
      {ready && (
        <button
          data-testid="canvas-save"
          disabled={!dirty || saving}
          onClick={() => void save.getState().save()}
        >
          Save
        </button>
      )}
      {error !== null && <span data-testid="flow-error">{error}</span>}
    </div>
  );
}

export function App({
  store,
  canvas,
  save,
}: {
  store: StoreApi<AppState>;
  canvas: StoreApi<CanvasState>;
  save: StoreApi<SaveState>;
}) {
  const version = useStore(store, (state) => state.version ?? state.versionError ?? "");
  const status = useStore(store, (state) => statusText(state.status));
  const ready = useStore(canvas, (state) => state.ready);
  const onSave = useCallback(() => void save.getState().save(), [save]);
  return (
    <main>
      <h1 data-testid="app-title">Flowdeck</h1>
      <p data-testid="app-version">{version}</p>
      <p data-testid="store-status">{status}</p>
      <TitleStrip canvas={canvas} save={save} />
      {ready && <Canvas store={canvas} onSave={onSave} />}
      <ClosePrompt store={save} />
    </main>
  );
}
