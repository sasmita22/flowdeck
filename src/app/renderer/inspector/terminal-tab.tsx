import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import { SessionPicker } from "../terminal/session-picker.js";
import { selectAttachTarget, type TerminalState } from "../terminal/store.js";
import { TerminalView } from "../terminal/terminal-pane.js";

export function TerminalTab({ terminal }: { terminal: StoreApi<TerminalState> }) {
  const available = useStore(terminal, (state) => state.available);
  const poppedOut = useStore(terminal, (state) => state.poppedOut);
  const target = useStore(terminal, selectAttachTarget);
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
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <SessionPicker store={terminal} />
        <button
          className="fd-btn"
          data-testid="terminal-pop-out"
          title="Open the terminal in its own window"
          onClick={() => void terminal.getState().popOut()}
        >
          Pop out
        </button>
      </div>
      <TerminalView key={target ?? ""} store={terminal} style={{ flex: 1, minHeight: 240 }} />
    </div>
  );
}
