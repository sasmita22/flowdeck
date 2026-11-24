import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import type { SaveState } from "./save-store.js";
import { pageTestIds } from "./test-ids.js";

const saveWarningText = (count: number) =>
  `This changes ${count} ${count === 1 ? "blueprint" : "blueprints"}.`;

export function SavePrompt({ store }: { store: StoreApi<SaveState> }) {
  const warning = useStore(store, (state) => state.saveWarning);
  if (warning === null) return null;
  const { answerSaveWarning } = store.getState();
  return (
    <div className="fd-overlay">
      <div
        className="fd-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="save-warning-text"
        data-testid={pageTestIds.saveWarningDialog}
      >
        <p id="save-warning-text" data-testid={pageTestIds.saveWarningText}>
          {saveWarningText(warning.count)}
        </p>
        <div className="fd-dialog-actions">
          <button
            className="fd-btn fd-btn-primary"
            data-testid={pageTestIds.saveWarningSave}
            onClick={() => answerSaveWarning("save")}
          >
            Save
          </button>
          <button
            className="fd-btn"
            data-testid={pageTestIds.saveWarningCancel}
            onClick={() => answerSaveWarning("cancel")}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
