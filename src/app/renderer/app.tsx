import { useCallback } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import type { AppState } from "./app-store.js";
import { Canvas } from "./canvas/canvas.js";
import { selectDirty, type CanvasState } from "./canvas/store.js";
import { RunStoreContext } from "./canvas/status.js";
import { ClosePrompt } from "./close-prompt.js";
import { selectRunDisabled, type RunState } from "./run-store.js";
import type { SaveState } from "./save-store.js";
import { selectOpenDisabled, type TerminalState } from "./terminal/store.js";
import { TerminalPane } from "./terminal/terminal-pane.js";

const statusText = (status: AppState["status"]) =>
  status.kind === "error" ? status.message : status.kind;

function TitleStrip({
  canvas,
  save,
  run,
  terminal,
}: {
  canvas: StoreApi<CanvasState>;
  save: StoreApi<SaveState>;
  run: StoreApi<RunState>;
  terminal: StoreApi<TerminalState>;
}) {
  const ready = useStore(canvas, (state) => state.ready);
  const dirty = useStore(canvas, selectDirty);
  const folder = useStore(canvas, (state) => state.flow.session.workingFolder);
  const saving = useStore(save, (state) => state.saving);
  const error = useStore(save, (state) => state.error);
  const runDisabled = useStore(run, (state) => selectRunDisabled(state, { saving }));
  const runError = useStore(run, (state) => state.error);
  const openDisabled = useStore(terminal, selectOpenDisabled);
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
      {ready && (
        <label>
          Working folder{" "}
          <input
            data-testid="flow-folder"
            type="text"
            value={folder.kind === "path" ? folder.path : ""}
            onChange={(event) => canvas.getState().setWorkingFolder(event.target.value)}
          />
        </label>
      )}
      {ready && (
        <button
          data-testid="canvas-run"
          disabled={runDisabled}
          onClick={() => void run.getState().run()}
        >
          Run
        </button>
      )}
      {ready && (
        <button
          data-testid="terminal-open"
          disabled={openDisabled}
          onClick={() => terminal.getState().show()}
        >
          Open terminal
        </button>
      )}
      {error !== null && <span data-testid="flow-error">{error}</span>}
      {runError !== null && <span data-testid="run-error">{runError}</span>}
    </div>
  );
}

export function App({
  store,
  canvas,
  save,
  run,
  terminal,
}: {
  store: StoreApi<AppState>;
  canvas: StoreApi<CanvasState>;
  save: StoreApi<SaveState>;
  run: StoreApi<RunState>;
  terminal: StoreApi<TerminalState>;
}) {
  const version = useStore(store, (state) => state.version ?? state.versionError ?? "");
  const status = useStore(store, (state) => statusText(state.status));
  const ready = useStore(canvas, (state) => state.ready);
  const terminalVisible = useStore(terminal, (state) => state.visible);
  const onSave = useCallback(() => void save.getState().save(), [save]);
  return (
    <main>
      <h1 data-testid="app-title">Flowdeck</h1>
      <p data-testid="app-version">{version}</p>
      <p data-testid="store-status">{status}</p>
      <TitleStrip canvas={canvas} save={save} run={run} terminal={terminal} />
      <RunStoreContext.Provider value={run}>
        {ready && <Canvas store={canvas} onSave={onSave} />}
      </RunStoreContext.Provider>
      {terminalVisible && <TerminalPane store={terminal} />}
      <ClosePrompt store={save} />
    </main>
  );
}
