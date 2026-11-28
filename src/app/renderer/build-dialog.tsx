import { useEffect, type CSSProperties } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import { modelChoices } from "../../core/flow/choices.js";
import type { BranchState } from "./branch-store.js";
import { BranchField } from "./fields/branch-field.js";
import { ModelField } from "./fields/model-field.js";
import { RepoField } from "./fields/repo-field.js";
import { VariableField } from "./fields/variable-field.js";
import type { LibraryState } from "./library-store.js";
import type { NavState } from "./nav-store.js";
import {
  selectBuildRefusal,
  selectCanBuild,
  selectExistingBranches,
  variableGroups,
  type BranchMode,
  type BuildDialog as Dialog,
  type RunState,
} from "./run-store.js";
import { buildDialogTestIds, controlTestIds } from "./test-ids.js";
import type { BuildTargetSession } from "./workspace-store.js";

const fieldStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  fontSize: "var(--fs-sm)",
};

const errorStyle: CSSProperties = { margin: 0, color: "var(--warn)", fontSize: "var(--fs-sm)" };

const choiceRowStyle: CSSProperties = { display: "flex", gap: 8 };

const existingListStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  maxHeight: 160,
  overflowY: "auto",
};

const existingBranchStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-start",
  gap: 2,
  textAlign: "left",
};

const branchNameStyle: CSSProperties = { minWidth: 0, overflowWrap: "anywhere" };

const reasonStyle: CSSProperties = {
  minWidth: 0,
  color: "var(--muted)",
  fontSize: "var(--fs-xs)",
  overflowWrap: "anywhere",
};

const sessionListStyle: CSSProperties = {
  margin: 0,
  padding: 0,
  listStyle: "none",
  display: "flex",
  flexDirection: "column",
  gap: 6,
};

const sessionStyle: CSSProperties = { display: "flex", flexDirection: "column", gap: 2 };

const branchModes: readonly { mode: BranchMode; label: string; testId: string }[] = [
  { mode: "new", label: "New branch", testId: buildDialogTestIds.branchNew },
  { mode: "existing", label: "Existing branch", testId: buildDialogTestIds.branchExisting },
];

const choiceClass = (chosen: boolean) => (chosen ? "fd-btn fd-btn-primary" : "fd-btn");

function ExistingBranchList({ dialog, run }: { dialog: Dialog; run: StoreApi<RunState> }) {
  const existing = selectExistingBranches({ buildDialog: dialog });
  return (
    <div style={existingListStyle} role="group" aria-label="Existing branch">
      {existing.map(({ name, reason }) => {
        const chosen = dialog.existingBranch === name;
        return (
          <button
            key={name}
            type="button"
            className={choiceClass(chosen)}
            style={existingBranchStyle}
            data-testid={buildDialogTestIds.existingBranch(name)}
            aria-pressed={chosen}
            disabled={reason !== null}
            title={reason ?? undefined}
            onClick={() => run.getState().editBuild({ existingBranch: name })}
          >
            <span style={branchNameStyle}>{name}</span>
            {reason !== null && <span style={reasonStyle}>{reason}</span>}
          </button>
        );
      })}
    </div>
  );
}

function BranchChoice({
  dialog,
  run,
  branches,
}: {
  dialog: Dialog;
  run: StoreApi<RunState>;
  branches: StoreApi<BranchState>;
}) {
  const edit = run.getState().editBuild;
  if (!dialog.target.existingBranch) {
    return (
      <label style={fieldStyle}>
        Branch name
        <input
          data-testid={buildDialogTestIds.branchName}
          value={dialog.branchName}
          onChange={(event) => edit({ branchName: event.target.value })}
        />
      </label>
    );
  }
  return (
    <>
      <div style={fieldStyle}>
        Branch
        <div style={choiceRowStyle} role="group" aria-label="Branch">
          {branchModes.map(({ mode, label, testId }) => (
            <button
              key={mode}
              type="button"
              className={choiceClass(dialog.branchMode === mode)}
              data-testid={testId}
              aria-pressed={dialog.branchMode === mode}
              onClick={() => edit({ branchMode: mode })}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {dialog.branchMode === "new" ? (
        <>
          <BranchField
            repo={dialog.repo}
            value={dialog.base}
            branches={branches}
            testId={buildDialogTestIds.base}
            infoTestId={buildDialogTestIds.baseInfo}
            errorTestId={buildDialogTestIds.branchesError}
            onChange={(base) => edit({ base })}
          />
          <label style={fieldStyle}>
            Branch name
            <input
              data-testid={buildDialogTestIds.branchName}
              value={dialog.branchName}
              onChange={(event) => edit({ branchName: event.target.value })}
            />
          </label>
        </>
      ) : (
        <ExistingBranchList dialog={dialog} run={run} />
      )}
    </>
  );
}

function SessionTargets({ sessions }: { sessions: readonly BuildTargetSession[] }) {
  return (
    <div style={fieldStyle}>
      Sessions
      <ul data-testid={buildDialogTestIds.sessions} style={sessionListStyle}>
        {sessions.map(({ name, repo, branch }, index) => (
          <li
            key={`${index}-${name}`}
            data-testid={buildDialogTestIds.session(name)}
            style={sessionStyle}
          >
            <span style={branchNameStyle}>{name}</span>
            <span data-testid={buildDialogTestIds.sessionRepo(name)} style={reasonStyle}>
              {repo}
            </span>
            <span data-testid={buildDialogTestIds.sessionBranch(name)} style={reasonStyle}>
              from {branch}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function BuildForm({
  dialog,
  canBuild,
  refusal,
  run,
  branches,
  onBuild,
}: {
  dialog: Dialog;
  canBuild: boolean;
  refusal: string | null;
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
      {dialog.target.repoOverride ? (
        <RepoField
          value={dialog.repo}
          testId={buildDialogTestIds.repo}
          browseTestId={buildDialogTestIds.repoBrowse}
          onCommit={setRepo}
          onBrowse={() => void branches.getState().browse(setRepo)}
        />
      ) : (
        <SessionTargets sessions={dialog.target.sessions} />
      )}
      {dialog.target.branch && <BranchChoice dialog={dialog} run={run} branches={branches} />}
      <ModelField
        label="Build model"
        value={dialog.buildModel}
        choices={modelChoices}
        testId={controlTestIds.buildModel}
        onChange={(buildModel) => edit({ buildModel })}
      />
      {variableGroups(dialog.variables).map(({ path, heading, variables }) => (
        <div
          key={path ?? ""}
          data-testid={path === null ? undefined : buildDialogTestIds.group(path)}
          style={{ display: "contents" }}
        >
          {heading !== null && <h3 className="fd-group-heading">{heading}</h3>}
          {variables.map((variable) => (
            <VariableField
              key={variable.name}
              variable={variable}
              value={dialog.values[variable.name]}
              testId={buildDialogTestIds.variable(variable.name)}
              onChange={(value) => run.getState().setValue(variable.name, value)}
            />
          ))}
        </div>
      ))}
      {refusal !== null && (
        <p data-testid={buildDialogTestIds.refusal} role="status" style={errorStyle}>
          {refusal}
        </p>
      )}
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

function IgnoredStep({
  dialog,
  starting,
  run,
  onBuild,
}: {
  dialog: Dialog;
  starting: boolean;
  run: StoreApi<RunState>;
  onBuild(): void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, width: 380 }}>
      <p id="build-dialog-title" style={{ margin: 0 }}>
        These nodes aren't connected to the main flow and will be left out
      </p>
      <ul data-testid={buildDialogTestIds.ignored} style={{ margin: 0, paddingLeft: 20 }}>
        {dialog.ignored.map((node) => (
          <li key={node.id} data-testid={buildDialogTestIds.ignoredNode(node.id)}>
            {node.label}
          </li>
        ))}
      </ul>
      {dialog.error !== null && (
        <p data-testid={buildDialogTestIds.error} role="alert" style={errorStyle}>
          {dialog.error}
        </p>
      )}
      <div className="fd-dialog-actions" style={{ justifyContent: "flex-end" }}>
        <button
          className="fd-btn"
          data-testid={buildDialogTestIds.ignoredCancel}
          onClick={() => run.getState().cancelBuild()}
        >
          Cancel
        </button>
        <button
          className="fd-btn fd-btn-primary"
          data-testid={buildDialogTestIds.buildAnyway}
          disabled={starting}
          onClick={onBuild}
        >
          Build anyway
        </button>
      </div>
    </div>
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
  const starting = useStore(run, (state) => state.starting);
  const canBuild = useStore(run, (state) => selectCanBuild(state) && !state.starting);
  const refusal = useStore(run, selectBuildRefusal);
  const repo = dialog?.repo ?? "";

  useEffect(() => {
    void branches.getState().load(repo);
  }, [branches, repo]);

  if (dialog === null) return null;
  const build = async () => {
    const pendingId = await run.getState().confirmBuild();
    if (pendingId === null) return;
    void library.getState().refresh();
    nav.getState().go({ name: "building", pendingId });
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
        {dialog.step === "confirm" ? (
          <IgnoredStep dialog={dialog} starting={starting} run={run} onBuild={() => void build()} />
        ) : (
          <BuildForm
            dialog={dialog}
            canBuild={canBuild}
            refusal={refusal}
            run={run}
            branches={branches}
            onBuild={() => void build()}
          />
        )}
      </div>
    </div>
  );
}
