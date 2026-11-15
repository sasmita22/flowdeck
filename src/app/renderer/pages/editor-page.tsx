import { useCallback, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { AssistantState } from "../assistant/assistant-store.js";
import { BlueprintTerminalPane } from "../assistant/blueprint-terminal-pane.js";
import type { BranchState } from "../branch-store.js";
import { Canvas } from "../canvas/canvas.js";
import { labelFor, selectDirty, type CanvasState } from "../canvas/store.js";
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

function AgentToggle({ assistant }: { assistant: StoreApi<AssistantState> }) {
  const visible = useStore(assistant, (state) => state.visible);
  return (
    <button
      className="fd-btn"
      data-testid={controlTestIds.blueprintTerminalToggle}
      aria-pressed={visible}
      title={visible ? "Hide the agent terminal" : "Show an agent terminal for this blueprint"}
      onClick={() => {
        if (visible) assistant.getState().hide();
        else void assistant.getState().show();
      }}
    >
      Agent
    </button>
  );
}

function EditorTitleRow({
  canvas,
  save,
  run,
  terminal,
  shell,
  nav,
  assistant,
}: {
  canvas: StoreApi<CanvasState>;
  save: StoreApi<SaveState>;
  run: StoreApi<RunState>;
  terminal: StoreApi<TerminalState>;
  shell: StoreApi<ShellState>;
  nav: StoreApi<NavState>;
  assistant: StoreApi<AssistantState>;
}) {
  const ready = useStore(canvas, (state) => state.ready);
  const dirty = useStore(canvas, selectDirty);
  const saving = useStore(save, (state) => state.saving);
  const starting = useStore(run, (state) => state.starting);
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
        {ready && <AgentToggle assistant={assistant} />}
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
  assistant,
  blueprintTerminal,
}: {
  canvas: StoreApi<CanvasState>;
  save: StoreApi<SaveState>;
  run: StoreApi<RunState>;
  terminal: StoreApi<TerminalState>;
  inspector: StoreApi<InspectorState>;
  shell: StoreApi<ShellState>;
  nav: StoreApi<NavState>;
  branches?: StoreApi<BranchState>;
  assistant: StoreApi<AssistantState>;
  blueprintTerminal: StoreApi<TerminalState>;
}) {
  const ready = useStore(canvas, (state) => state.ready);
  const agentVisible = useStore(assistant, (state) => state.visible);
  const onSave = useCallback(() => void save.getState().save(), [save]);
  const sessionName = useStore(canvas, (state) => state.flow.session.name);
  const nodes = useStore(canvas, (state) => state.flow.nodes);
  const labels = useMemo(
    () => ({
      sessionName,
      nodes: nodes.map((node) => ({ id: node.id, label: labelFor(node) })),
    }),
    [sessionName, nodes],
  );
  const highlight = useCallback((nodeId: string) => canvas.getState().highlight(nodeId), [canvas]);
  return (
    <>
      <EditorTitleRow
        canvas={canvas}
        save={save}
        run={run}
        terminal={terminal}
        shell={shell}
        nav={nav}
        assistant={assistant}
      />
      <div className="fd-main">
        {ready && (
          <Canvas
            store={canvas}
            shell={shell}
            run={idle}
            onSave={onSave}
            below={
              agentVisible ? (
                <BlueprintTerminalPane
                  assistant={assistant}
                  terminal={blueprintTerminal}
                  save={save}
                />
              ) : null
            }
          />
        )}
        {ready && (
          <InspectorPanel
            shell={shell}
            run={idle}
            canvas={canvas}
            labels={labels}
            onSelectNode={highlight}
            inspector={inspector}
            branches={branches}
          />
        )}
      </div>
    </>
  );
}
