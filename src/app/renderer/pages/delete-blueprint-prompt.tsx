import { useMemo } from "react";
import { useStore } from "zustand";
import { usedBy } from "../../../core/flow/libraries.js";
import type { StoreApi } from "zustand/vanilla";
import type { Actions } from "../actions.js";
import type { LibraryState } from "../library-store.js";
import type { SaveState } from "../save-store.js";
import { pageTestIds } from "../test-ids.js";
import { UsedByList } from "../used-by-list.js";
import { openUserFromDelete } from "../used-by.js";

export function DeleteBlueprintPrompt({
  library,
  save,
  actions,
}: {
  library: StoreApi<LibraryState>;
  save: StoreApi<SaveState>;
  actions: Actions;
}) {
  const question = useStore(library, (state) => state.confirmingDelete);
  const heldFlowId = useStore(save, (state) => state.flowId);
  const flows = useStore(library, (state) => state.flows);
  const users = useMemo(
    () => (question === null ? [] : usedBy(flows, question.flowId)),
    [flows, question],
  );
  if (question === null) return null;
  const { cancelDelete } = library.getState();
  const inUse = users.length > 0;
  return (
    <div className="fd-overlay">
      <div
        className="fd-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-blueprint-text"
        data-testid={pageTestIds.blueprintDeleteDialog}
      >
        {inUse ? (
          <>
            <p id="delete-blueprint-text" data-testid={pageTestIds.blueprintDeleteInUse}>
              This library is used by these blueprints. Remove it from each of them before deleting
              it.
            </p>
            <UsedByList
              scope="delete"
              libraryId={question.flowId}
              users={users}
              onOpen={openUserFromDelete(library.getState(), actions)}
            />
          </>
        ) : (
          <p id="delete-blueprint-text">
            Delete {question.name}? Its builds and runs are kept.
            {heldFlowId === question.flowId && " Unsaved changes to it are lost."}
          </p>
        )}
        <div className="fd-dialog-actions">
          {!inUse && (
            <button
              className="fd-btn fd-btn-primary"
              data-testid={pageTestIds.blueprintDeleteConfirm}
              onClick={() => void actions.deleteBlueprint(question.flowId)}
            >
              Delete
            </button>
          )}
          <button
            className="fd-btn"
            data-testid={pageTestIds.blueprintDeleteCancel}
            onClick={cancelDelete}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
