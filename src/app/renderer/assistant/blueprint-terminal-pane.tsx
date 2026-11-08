import { useEffect } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import type { TerminalState } from "../terminal/store.js";
import { TerminalView } from "../terminal/terminal-pane.js";
import { blueprintTerminalTestId } from "../test-ids.js";
import type { AssistantState } from "./assistant-store.js";

export function BlueprintTerminalPane({
  assistant,
  terminal,
}: {
  assistant: StoreApi<AssistantState>;
  terminal: StoreApi<TerminalState>;
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
      {session !== null && viewing === session && available && (
        <TerminalView store={terminal} style={{ width: "100%", height: "40vh" }} />
      )}
    </section>
  );
}
