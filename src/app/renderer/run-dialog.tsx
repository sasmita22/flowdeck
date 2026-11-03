import { useState, type CSSProperties } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import type { Actions } from "./actions.js";
import type { RunChoice, RunState } from "./run-store.js";
import { dialogTestIds } from "./test-ids.js";

const toggleStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 8,
  fontSize: "var(--fs-sm)",
};

const hintStyle: CSSProperties = { margin: 0, color: "var(--muted)", fontSize: "var(--fs-xs)" };

function RunForm({
  starting,
  onStart,
  onCancel,
}: {
  starting: boolean;
  onStart(choice: RunChoice): void;
  onCancel(): void;
}) {
  const [auto, setAuto] = useState(false);
  return (
    <form
      style={{ display: "flex", flexDirection: "column", gap: 14, width: 360 }}
      onSubmit={(event) => {
        event.preventDefault();
        onStart({ auto });
      }}
    >
      <h2 id="run-dialog-title" style={{ margin: 0, fontSize: "var(--fs-lg)" }}>
        Run options
      </h2>
      <label style={toggleStyle}>
        <input
          type="checkbox"
          data-testid={dialogTestIds.auto}
          checked={auto}
          onChange={(event) => setAuto(event.target.checked)}
        />
        <span>
          Automatic mode
          <p style={hintStyle}>
            Skips gates marked &lsquo;skip in automatic runs&rsquo;. Hard stops still stop.
          </p>
        </span>
      </label>
      <div className="fd-dialog-actions" style={{ justifyContent: "flex-end" }}>
        <button
          type="button"
          className="fd-btn"
          data-testid={dialogTestIds.cancel}
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          type="submit"
          className="fd-btn fd-btn-primary"
          data-testid={dialogTestIds.start}
          disabled={starting}
        >
          Start
        </button>
      </div>
    </form>
  );
}

export function RunDialog({ run, actions }: { run: StoreApi<RunState>; actions: Actions }) {
  const dialog = useStore(run, (state) => state.dialog);
  const starting = useStore(run, (state) => state.starting);
  if (dialog === null) return null;
  return (
    <div className="fd-overlay">
      <div
        className="fd-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="run-dialog-title"
        data-testid={dialogTestIds.dialog}
      >
        <RunForm
          key={dialog.buildId}
          starting={starting}
          onStart={(choice) => void actions.startRun(choice)}
          onCancel={() => run.getState().cancelDialog()}
        />
      </div>
    </div>
  );
}
