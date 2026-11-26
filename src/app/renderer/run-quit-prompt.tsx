import { useEffect } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import type { SaveState } from "./save-store.js";
import { pageTestIds } from "./test-ids.js";

export function RunQuitPrompt({ store }: { store: StoreApi<SaveState> }) {
  const prompt = useStore(store, (state) => state.runQuitPrompt);
  const asking = prompt === "asking";

  useEffect(() => {
    if (!asking) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") store.getState().answerRunQuit("cancel");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [store, asking]);

  if (prompt === "closed") return null;
  const { answerRunQuit } = store.getState();
  return (
    <div
      className="fd-overlay"
      data-testid={pageTestIds.runQuitOverlay}
      onClick={(event) => {
        if (asking && event.target === event.currentTarget) answerRunQuit("cancel");
      }}
    >
      <div
        className="fd-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="run-quit-title"
        aria-describedby="run-quit-text"
        data-testid={pageTestIds.runQuitDialog}
      >
        <h2 id="run-quit-title" style={{ margin: 0, fontSize: "var(--fs-lg)" }}>
          Runs or builds are still going
        </h2>
        <p id="run-quit-text">
          Keep them going in the background after Flowdeck quits, or stop them now?
        </p>
        <div className="fd-dialog-actions">
          <button
            className="fd-btn fd-btn-primary"
            data-testid={pageTestIds.runQuitKeep}
            disabled={!asking}
            onClick={() => answerRunQuit("keep")}
          >
            Keep running
          </button>
          <button
            className="fd-btn"
            data-testid={pageTestIds.runQuitStop}
            disabled={!asking}
            onClick={() => answerRunQuit("stop")}
          >
            {asking ? "Stop and quit" : "Stopping…"}
          </button>
          <button
            className="fd-btn"
            data-testid={pageTestIds.runQuitCancel}
            disabled={!asking}
            onClick={() => answerRunQuit("cancel")}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
