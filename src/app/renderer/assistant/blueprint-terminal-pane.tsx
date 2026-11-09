import { useEffect } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import { Icon } from "../icons.js";
import type { SaveState } from "../save-store.js";
import type { TerminalState } from "../terminal/store.js";
import { TerminalView } from "../terminal/terminal-pane.js";
import { blueprintTerminalTestId, controlTestIds } from "../test-ids.js";
import type { AssistantState } from "./assistant-store.js";
import { StopAgentPrompt } from "./stop-agent-prompt.js";

function PaneHeader({
  assistant,
  save,
}: {
  assistant: StoreApi<AssistantState>;
  save: StoreApi<SaveState>;
}) {
  const running = useStore(assistant, (state) => state.session !== null);
  const name = useStore(save, (state) => state.name);
  const { hide, askStop } = assistant.getState();
  return (
    <header className="fd-panel-head fd-blueprint-terminal-head">
      <div className="fd-blueprint-terminal-title">
        <h2 className="fd-panel-title">Agent</h2>
        <span className="fd-blueprint-terminal-name">{name}</span>
        <span className="fd-blueprint-terminal-state">{running ? "running" : "not running"}</span>
      </div>
      <div className="fd-blueprint-terminal-actions">
        <button
          className="fd-btn fd-icon-btn"
          data-testid={controlTestIds.blueprintTerminalMinimize}
          title="Minimize"
          aria-label="Minimize"
          onClick={hide}
        >
          <Icon name="minimize" />
        </button>
        <button
          className="fd-btn fd-icon-btn"
          data-testid={controlTestIds.blueprintTerminalClose}
          title="Stop the agent"
          aria-label="Stop the agent"
          onClick={askStop}
        >
          <Icon name="close" />
        </button>
      </div>
    </header>
  );
}

export function BlueprintTerminalPane({
  assistant,
  terminal,
  save,
}: {
  assistant: StoreApi<AssistantState>;
  terminal: StoreApi<TerminalState>;
  save: StoreApi<SaveState>;
}) {
  const session = useStore(assistant, (state) => state.session);
  const viewing = useStore(terminal, (state) => state.runId);
  const available = useStore(terminal, (state) => state.available);

  useEffect(() => {
    if (session === null) return;
    void terminal.getState().view(session);
    return () => terminal.getState().close();
  }, [terminal, session]);

  return (
    <section
      className="fd-blueprint-terminal"
      data-testid={blueprintTerminalTestId}
      aria-label="Blueprint agent"
    >
      <PaneHeader assistant={assistant} save={save} />
      {session !== null && viewing === session && available && (
        <TerminalView store={terminal} style={{ flex: 1, minHeight: 0 }} />
      )}
      <StopAgentPrompt assistant={assistant} />
    </section>
  );
}
