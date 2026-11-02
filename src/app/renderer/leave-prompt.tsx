import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import type { SaveState } from "./save-store.js";
import { pageTestIds } from "./test-ids.js";

export function LeavePrompt({ store }: { store: StoreApi<SaveState> }) {
  const open = useStore(store, (state) => state.leavePrompt);
  const saving = useStore(store, (state) => state.saving);
  const name = useStore(store, (state) => state.name);
  if (!open) return null;
  const { answerLeave } = store.getState();
  return (
    <div className="fd-overlay">
      <div className="fd-dialog" role="dialog" aria-modal="true" aria-labelledby="leave-text">
        <p id="leave-text">Save changes to {name} first?</p>
        <div className="fd-dialog-actions">
          <button
            className="fd-btn fd-btn-primary"
            data-testid={pageTestIds.leaveSave}
            disabled={saving}
            onClick={() => void answerLeave("save")}
          >
            Save
          </button>
          <button
            className="fd-btn"
            data-testid={pageTestIds.leaveDiscard}
            disabled={saving}
            onClick={() => void answerLeave("discard")}
          >
            Don't save
          </button>
          <button
            className="fd-btn"
            data-testid={pageTestIds.leaveCancel}
            disabled={saving}
            onClick={() => void answerLeave("cancel")}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
