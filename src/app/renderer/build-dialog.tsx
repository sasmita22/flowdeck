import { useEffect, type CSSProperties } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import type { Variable } from "../../core/flow/schema.js";
import type { BranchState } from "./branch-store.js";
import { BranchField } from "./fields/branch-field.js";
import { buildModelChoices } from "./fields/field-options.js";
import { ModelField } from "./fields/model-field.js";
import { RepoField } from "./fields/repo-field.js";
import type { LibraryState } from "./library-store.js";
import type { NavState } from "./nav-store.js";
import { selectCanBuild, type BuildDialog as Dialog, type RunState } from "./run-store.js";
import { buildDialogTestIds, controlTestIds } from "./test-ids.js";

const fieldStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  fontSize: "var(--fs-sm)",
};

const errorStyle: CSSProperties = { margin: 0, color: "var(--warn)", fontSize: "var(--fs-sm)" };

const yesNo = (value: string | boolean | undefined) =>
  value === true ? "yes" : value === false ? "no" : "";

function VariableField({
  variable,
  value,
  onChange,
}: {
  variable: Variable;
  value: string | boolean | undefined;
  onChange(value: string | boolean): void;
}) {
  const testId = buildDialogTestIds.variable(variable.name);
  return (
    <label style={fieldStyle}>
      {variable.name}
      {variable.kind === "text" ? (
        <input
          data-testid={testId}
          value={typeof value === "string" ? value : ""}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <select
          data-testid={testId}
          value={yesNo(value)}
          onChange={(event) => onChange(event.target.value === "yes")}
        >
          <option value="" disabled>
            Choose
          </option>
          <option value="yes">Yes</option>
          <option value="no">No</option>
        </select>
      )}
    </label>
  );
}

function BuildForm({
  dialog,
  canBuild,
  run,
  branches,
  onBuild,
}: {
  dialog: Dialog;
  canBuild: boolean;
  run: StoreApi<RunState>;
  branches: StoreApi<BranchState>;
  onBuild(): void;
}) {
  const edit = run.getState().editBuild;
  const setRepo = (repo: string) => edit({ repo });
  return (
    <form
      style={{ display: "flex", flexDirection: "column", gap: 14, width: 380 }}
      onSubmit={(event) => {
        event.preventDefault();
        onBuild();
      }}
    >
      <h2 id="build-dialog-title" style={{ margin: 0, fontSize: "var(--fs-lg)" }}>
        Build
      </h2>
      <label style={fieldStyle}>
        Name
        <input
          data-testid={buildDialogTestIds.name}
          placeholder="fix-login"
          value={dialog.name}
          onChange={(event) => edit({ name: event.target.value })}
        />
      </label>
      <RepoField
        value={dialog.repo}
        testId={buildDialogTestIds.repo}
        browseTestId={buildDialogTestIds.repoBrowse}
        onCommit={setRepo}
        onBrowse={() => void branches.getState().browse(setRepo)}
      />
      <BranchField
        repo={dialog.repo}
        value={dialog.base}
        branches={branches}
        testId={buildDialogTestIds.base}
        infoTestId={buildDialogTestIds.baseInfo}
        errorTestId={buildDialogTestIds.branchesError}
        onChange={(base) => edit({ base })}
      />
      <ModelField
        label="Build model"
        value={dialog.buildModel}
        choices={buildModelChoices}
        testId={controlTestIds.buildModel}
        onChange={(buildModel) => edit({ buildModel })}
      />
      {dialog.variables.map((variable) => (
        <VariableField
          key={variable.name}
          variable={variable}
          value={dialog.values[variable.name]}
          onChange={(value) => run.getState().setValue(variable.name, value)}
        />
      ))}
      {dialog.error !== null && (
        <p data-testid={buildDialogTestIds.error} role="alert" style={errorStyle}>
          {dialog.error}
        </p>
      )}
      <div className="fd-dialog-actions" style={{ justifyContent: "flex-end" }}>
        <button
          type="button"
          className="fd-btn"
          data-testid={buildDialogTestIds.cancel}
          onClick={() => run.getState().cancelBuild()}
        >
          Cancel
        </button>
        <button
          type="submit"
          className="fd-btn fd-btn-primary"
          data-testid={buildDialogTestIds.confirm}
          disabled={!canBuild}
        >
          Build
        </button>
      </div>
    </form>
  );
}

export function BuildDialog({
  run,
  nav,
  library,
  branches,
}: {
  run: StoreApi<RunState>;
  nav: StoreApi<NavState>;
  library: StoreApi<LibraryState>;
  branches: StoreApi<BranchState>;
}) {
  const dialog = useStore(run, (state) => state.buildDialog);
  const canBuild = useStore(run, (state) => selectCanBuild(state) && !state.starting);
  const repo = dialog?.repo ?? "";

  useEffect(() => {
    void branches.getState().load(repo);
  }, [branches, repo]);

  if (dialog === null) return null;
  const build = async () => {
    const buildId = await run.getState().confirmBuild();
    if (buildId === null) return;
    void library.getState().refresh();
    nav.getState().go({ name: "builds", buildId });
  };
  return (
    <div className="fd-overlay">
      <div
        className="fd-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="build-dialog-title"
        data-testid={buildDialogTestIds.dialog}
      >
        <BuildForm
          dialog={dialog}
          canBuild={canBuild}
          run={run}
          branches={branches}
          onBuild={() => void build()}
        />
      </div>
    </div>
  );
}
