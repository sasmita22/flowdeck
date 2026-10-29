import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import type { SaveState } from "./save-store.js";

const overlayStyle = {
  position: "fixed",
  inset: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "rgba(0, 0, 0, 0.3)",
  zIndex: 10,
} as const;

const dialogStyle = { background: "#fff", padding: 16, borderRadius: 6 } as const;

export function ClosePrompt({ store }: { store: StoreApi<SaveState> }) {
  const open = useStore(store, (state) => state.closePrompt);
  const saving = useStore(store, (state) => state.saving);
  if (!open) return null;
  const { answerClose } = store.getState();
  return (
    <div style={overlayStyle}>
      <div role="dialog" aria-modal="true" aria-labelledby="close-prompt-text" style={dialogStyle}>
        <p id="close-prompt-text">Save changes before closing?</p>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            data-testid="close-save"
            disabled={saving}
            onClick={() => void answerClose("save")}
          >
            Save
          </button>
          <button
            data-testid="close-discard"
            disabled={saving}
            onClick={() => void answerClose("discard")}
          >
            Don't save
          </button>
          <button
            data-testid="close-cancel"
            disabled={saving}
            onClick={() => void answerClose("cancel")}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
