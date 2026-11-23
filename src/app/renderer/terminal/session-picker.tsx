import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import { pageTestIds } from "../test-ids.js";
import { selectAttachTarget, type TerminalState } from "./store.js";

export function SessionPicker({ store }: { store: StoreApi<TerminalState> }) {
  const sessions = useStore(store, (state) => state.sessions);
  const target = useStore(store, selectAttachTarget);
  if (sessions.length < 2) return null;
  return (
    <div role="group" aria-label="Session" data-testid={pageTestIds.terminalSessionPicker}>
      {sessions.map(({ container, tmuxName }) => (
        <button
          key={container}
          className="fd-btn"
          data-testid={pageTestIds.terminalSessionOption(container)}
          aria-pressed={tmuxName === target}
          title={`Watch the ${container} session`}
          onClick={() => store.getState().chooseSession(container)}
        >
          {container}
        </button>
      ))}
    </div>
  );
}
