import { useCallback, useRef, useState, type KeyboardEvent } from "react";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { BranchState } from "../branch-store.js";
import { Canvas } from "../canvas/canvas.js";
import { selectDirty, type CanvasState } from "../canvas/store.js";
import { InspectorPanel } from "../inspector-panel.js";
import type { InspectorState } from "../inspector/store.js";
import { MoreMenu } from "../more-menu.js";
import type { NavState } from "../nav-store.js";
import type { RunState, RunView } from "../run-store.js";
import type { SaveState } from "../save-store.js";
import { SessionSettingsButton } from "../session-settings-button.js";
import type { ShellState } from "../shell-store.js";
import type { TerminalState } from "../terminal/store.js";
import { controlTestIds } from "../test-ids.js";

const idle: StoreApi<RunView> = createStore<RunView>()(() => ({ snapshot: null }));

function FlowTitle({ save }: { save: StoreApi<SaveState> }) {
  const name = useStore(save, (state) => state.name);
  const [draft, setDraft] = useState<string | null>(null);
  const cancelled = useRef(false);

  const commit = () => {
    const skip = cancelled.current;
    cancelled.current = false;
    if (draft === null) return;
    setDraft(null);
    if (skip) return;
    if (draft.trim() !== "" && draft.trim() !== name) void save.getState().rename(draft);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") event.currentTarget.blur();
    if (event.key === "Escape") {
      cancelled.current = true;
      event.currentTarget.blur();
    }
  };

  return (
    <input
      className="fd-title-input"
      data-testid={controlTestIds.title}
      aria-label="Blueprint name"
      title="Rename this blueprint"
      size={Math.max(8, (draft ?? name).length + 1)}
      value={draft ?? name}
      onFocus={() => setDraft(name)}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={onKeyDown}
      onBlur={commit}
    />
  );
}

function EditorTitleRow({
  canvas,
  save,
  run,
  terminal,
  shell,
  nav,
}: {
  canvas: StoreApi<CanvasState>;
  save: StoreApi<SaveState>;
  run: StoreApi<RunState>;
  terminal: StoreApi<TerminalState>;
  shell: StoreApi<ShellState>;
  nav: StoreApi<NavState>;
}) {
  const ready = useStore(canvas, (state) => state.ready);
  const dirty = useStore(canvas, selectDirty);
  const saving = useStore(save, (state) => state.saving);
  const flowId = useStore(save, (state) => state.flowId);
  const starting = useStore(run, (state) => state.starting);
  const lastBuild = useStore(run, (state) => state.lastBuild);
  const built = lastBuild !== null && lastBuild.flowId === flowId ? lastBuild : null;
  return (
    <header className="fd-title-row">
      <nav className="fd-crumbs" aria-label="Breadcrumb">
        <button
          className="fd-crumb"
          data-testid={controlTestIds.back}
          title="Back to all blueprints"
          onClick={() => nav.getState().go({ name: "blueprints" })}
        >
          Blueprints
        </button>
        <span aria-hidden="true">/</span>
        <FlowTitle save={save} />
      </nav>
      {ready && dirty && (
        <span className="fd-unsaved" data-testid="flow-unsaved">
          Unsaved
        </span>
      )}
      <div className="fd-title-actions">
        {built !== null && (
          <button
            className="fd-link"
            data-testid={controlTestIds.built}
            title="See this build's files"
            onClick={() => nav.getState().go({ name: "builds", buildId: built.id })}
          >
            Built v{built.version} · {built.name}
          </button>
        )}
        {ready && (
          <button
            className="fd-btn"
            data-testid={controlTestIds.save}
            disabled={!dirty || saving}
            onClick={() => void save.getState().save()}
          >
            Save
          </button>
        )}
        {ready && (
          <button
            className="fd-btn"
            data-testid={controlTestIds.build}
            disabled={saving || starting}
            title="Save if needed, then build a locked copy of this version under a name"
            onClick={() => void run.getState().openBuild()}
          >
            Build
          </button>
        )}
        {ready && <SessionSettingsButton shell={shell} />}
        {ready && <MoreMenu shell={shell} terminal={terminal} />}
      </div>
    </header>
  );
}

export function EditorPage({
  canvas,
  save,
  run,
  terminal,
  inspector,
  shell,
  nav,
  branches,
}: {
  canvas: StoreApi<CanvasState>;
  save: StoreApi<SaveState>;
  run: StoreApi<RunState>;
  terminal: StoreApi<TerminalState>;
  inspector: StoreApi<InspectorState>;
  shell: StoreApi<ShellState>;
  nav: StoreApi<NavState>;
  branches?: StoreApi<BranchState>;
}) {
  const ready = useStore(canvas, (state) => state.ready);
  const onSave = useCallback(() => void save.getState().save(), [save]);
  return (
    <>
      <EditorTitleRow
        canvas={canvas}
        save={save}
        run={run}
        terminal={terminal}
        shell={shell}
        nav={nav}
      />
      <div className="fd-main">
        {ready && <Canvas store={canvas} shell={shell} run={idle} onSave={onSave} />}
        {ready && (
          <InspectorPanel
            shell={shell}
            run={idle}
            canvas={canvas}
            inspector={inspector}
            branches={branches}
          />
        )}
      </div>
    </>
  );
}
