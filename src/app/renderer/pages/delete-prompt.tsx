import { useState } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import type { Actions } from "../actions.js";
import type { BuildProgressState } from "../build-progress-store.js";
import type { LibraryState } from "../library-store.js";
import type { NavState } from "../nav-store.js";
import type { ConfirmingDelete, RunState } from "../run-store.js";
import { pageTestIds } from "../test-ids.js";

const questionText = (question: ConfirmingDelete, name: string) =>
  question.kind === "run"
    ? `Delete run ${name}? A running run is stopped first.`
    : `Delete build ${name}? Its live work is stopped, and its workspace, worktree and Flowdeck branch are removed.`;

export function DeletePrompt({
  run,
  library,
  buildProgress,
  nav,
  actions,
}: {
  run: StoreApi<RunState>;
  library: StoreApi<LibraryState>;
  buildProgress: StoreApi<BuildProgressState>;
  nav: StoreApi<NavState>;
  actions: Actions;
}) {
  const question = useStore(run, (state) => state.confirmingDelete);
  const name = useStore(library, (state) => {
    if (question?.kind === "build")
      return state.builds.find((build) => build.id === question.id)?.name ?? null;
    if (question?.kind !== "run") return null;
    const found = state.runs.find((summary) => summary.id === question.id);
    return found === undefined ? null : `#${found.number} ${found.buildName ?? ""}`.trim();
  });
  const pendingName = useStore(buildProgress, (state) =>
    question?.kind === "pending" ? state.entries[question.id]?.name : undefined,
  );
  const [busy, setBusy] = useState(false);
  if (question === null) return null;
  const losesWork =
    question.kind === "build" &&
    (question.preview.dirtyWorktree || question.preview.unpushedBranch);
  const { cancelDelete } = run.getState();

  const confirm = async () => {
    setBusy(true);
    try {
      if (question.kind === "build") await actions.deleteBuild(question.id);
      else if (question.kind === "pending") await actions.deletePendingBuild(question.id);
      else {
        const deleted = await actions.deleteRun(question.id);
        if (deleted && question.from === "run-page") nav.getState().go({ name: "runs" });
      }
    } finally {
      setBusy(false);
      cancelDelete();
    }
  };

  return (
    <div className="fd-overlay">
      <div
        className="fd-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-prompt-text"
        data-testid={pageTestIds.deletePrompt}
      >
        <p id="delete-prompt-text">{questionText(question, pendingName ?? name ?? question.id)}</p>
        {losesWork && (
          <p className="fd-dialog-warning" data-testid={pageTestIds.deletePromptWarning}>
            Work that is not committed or not pushed will be lost.
          </p>
        )}
        <div className="fd-dialog-actions">
          <button
            className="fd-btn fd-btn-primary"
            data-testid={pageTestIds.deletePromptConfirm}
            disabled={busy}
            onClick={() => void confirm()}
          >
            Delete
          </button>
          <button
            className="fd-btn"
            data-testid={pageTestIds.deletePromptCancel}
            disabled={busy}
            onClick={cancelDelete}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
