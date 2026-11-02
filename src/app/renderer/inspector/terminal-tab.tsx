import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import type { TerminalState } from "../terminal/store.js";
import { TerminalView } from "../terminal/terminal-pane.js";

export function TerminalTab({ terminal }: { terminal: StoreApi<TerminalState> }) {
  const available = useStore(terminal, (state) => state.available);
  const poppedOut = useStore(terminal, (state) => state.poppedOut);
  if (!available) {
    return (
      <p data-testid="terminal-unavailable">
        No terminal: this run has no Claude session open right now.
      </p>
    );
  }
  if (poppedOut) {
    return <p data-testid="terminal-popped-out">The terminal is open in its own window.</p>;
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, flex: 1, minHeight: 0 }}>
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button
          className="fd-btn"
          data-testid="terminal-pop-out"
          title="Open the terminal in its own window"
          onClick={() => void terminal.getState().popOut()}
        >
          Pop out
        </button>
      </div>
      <TerminalView store={terminal} style={{ flex: 1, minHeight: 240 }} />
    </div>
  );
}
