import { useState, type CSSProperties } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import type { RunChoices } from "../../core/run/options.js";
import type { Actions } from "./actions.js";
import type { RunState } from "./run-store.js";
import { dialogTestIds } from "./test-ids.js";

const fieldStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  fontSize: "var(--fs-sm)",
};

const toggleStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 8,
  fontSize: "var(--fs-sm)",
};

const hintStyle: CSSProperties = { margin: 0, color: "var(--muted)", fontSize: "var(--fs-xs)" };

function RunForm({
  choices,
  starting,
  onStart,
  onCancel,
}: {
  choices: RunChoices;
  starting: boolean;
  onStart(options: {
    inputs: Record<string, string>;
    flags: Record<string, boolean>;
    auto: boolean;
  }): void;
  onCancel(): void;
}) {
  const [inputs, setInputs] = useState<Record<string, string>>(() =>
    Object.fromEntries(choices.inputs.map((name) => [name, ""])),
  );
  const [flags, setFlags] = useState<Record<string, boolean>>(choices.flags);
  const [auto, setAuto] = useState(false);
  return (
    <form
      style={{ display: "flex", flexDirection: "column", gap: 14, width: 360 }}
      onSubmit={(event) => {
        event.preventDefault();
        onStart({ inputs, flags, auto });
      }}
    >
      <h2 id="run-dialog-title" style={{ margin: 0, fontSize: "var(--fs-lg)" }}>
        Run options
      </h2>
      {choices.inputs.map((name) => (
        <label key={name} style={fieldStyle}>
          {name}
          <input
            data-testid={dialogTestIds.input(name)}
            value={inputs[name] ?? ""}
            onChange={(event) => setInputs({ ...inputs, [name]: event.target.value })}
          />
        </label>
      ))}
      {Object.keys(flags).map((name) => (
        <label key={name} style={toggleStyle}>
          <input
            type="checkbox"
            data-testid={dialogTestIds.flag(name)}
            checked={flags[name] === true}
            onChange={(event) => setFlags({ ...flags, [name]: event.target.checked })}
          />
          <span>
            {name}
            <p style={hintStyle}>{choices.flags[name] ? "On by default" : "Off by default"}</p>
          </span>
        </label>
      ))}
      {choices.automatic && (
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
      )}
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
          key={dialog.hash}
          choices={dialog.choices}
          starting={starting}
          onStart={(options) => void actions.startRun(options)}
          onCancel={() => run.getState().cancelDialog()}
        />
      </div>
    </div>
  );
}
