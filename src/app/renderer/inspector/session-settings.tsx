import { useEffect, type CSSProperties } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import { modelChoices } from "../../../core/flow/choices.js";
import type { Variable } from "../../../core/flow/schema.js";
import type { BranchState } from "../branch-store.js";
import { selectSessionIssues, type CanvasState } from "../canvas/store.js";
import { BranchField } from "../fields/branch-field.js";
import { ModelField } from "../fields/model-field.js";
import { RepoField } from "../fields/repo-field.js";
import { buildConfigTestIds } from "../test-ids.js";
import { Field, type Commit } from "./field.js";
import { applyField, sessionFields, type FieldDescription } from "./schema-form.js";

const noBranchState: BranchState = {
  repo: null,
  branches: null,
  error: null,
  load: async () => undefined,
  browse: async () => undefined,
};

const noBranches: StoreApi<BranchState> = {
  getState: () => noBranchState,
  getInitialState: () => noBranchState,
  setState: () => undefined,
  subscribe: () => () => undefined,
};

const rowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: 6,
  minWidth: 0,
  fontSize: "var(--fs-sm)",
};

const yesNo = (value: Variable["default"]) =>
  value === true ? "yes" : value === false ? "no" : "";

function withKind(variable: Variable, kind: string): Variable {
  if (kind === variable.kind) return variable;
  return kind === "yesno"
    ? { name: variable.name, kind: "yesno" }
    : { name: variable.name, kind: "text" };
}

function withDefault(variable: Variable, value: string): Variable {
  const { name } = variable;
  if (variable.kind === "text") {
    return value === "" ? { name, kind: "text" } : { name, kind: "text", default: value };
  }
  return value === "" ? { name, kind: "yesno" } : { name, kind: "yesno", default: value === "yes" };
}

function VariableRow({
  variable,
  index,
  canvas,
}: {
  variable: Variable;
  index: number;
  canvas: StoreApi<CanvasState>;
}) {
  const update = (next: Variable) => canvas.getState().updateVariable(index, next);
  return (
    <div style={rowStyle} data-testid={buildConfigTestIds.variable(variable.name)}>
      <input
        key={variable.name}
        type="text"
        data-testid={buildConfigTestIds.variableName(index)}
        aria-label="Variable name"
        defaultValue={variable.name}
        style={{ flex: "1 1 80px", minWidth: 0 }}
        onBlur={(event) => {
          const name = event.target.value.trim();
          if (name === "" || name === variable.name) event.target.value = variable.name;
          else update({ ...variable, name });
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
      />
      <select
        data-testid={buildConfigTestIds.variableKind(index)}
        aria-label={`${variable.name} kind`}
        value={variable.kind}
        onChange={(event) => update(withKind(variable, event.target.value))}
      >
        <option value="text">Text</option>
        <option value="yesno">Yes/no</option>
      </select>
      {variable.kind === "text" ? (
        <input
          key={`${variable.name}-${variable.default ?? ""}`}
          type="text"
          data-testid={buildConfigTestIds.variableDefault(index)}
          aria-label={`${variable.name} default`}
          placeholder="No default"
          defaultValue={variable.default ?? ""}
          style={{ flex: "1 1 80px", minWidth: 0 }}
          onBlur={(event) => {
            if (event.target.value !== (variable.default ?? "")) {
              update(withDefault(variable, event.target.value));
            }
          }}
        />
      ) : (
        <select
          data-testid={buildConfigTestIds.variableDefault(index)}
          aria-label={`${variable.name} default`}
          value={yesNo(variable.default)}
          onChange={(event) => update(withDefault(variable, event.target.value))}
        >
          <option value="">No default</option>
          <option value="yes">Yes</option>
          <option value="no">No</option>
        </select>
      )}
      <button
        className="fd-btn"
        data-testid={buildConfigTestIds.variableRemove(index)}
        aria-label={`Remove ${variable.name}`}
        onClick={() => canvas.getState().removeVariable(index)}
      >
        Remove
      </button>
    </div>
  );
}

function VariablesField({ canvas }: { canvas: StoreApi<CanvasState> }) {
  const variables = useStore(canvas, (state) => state.flow.session.buildConfig.variables);
  return (
    <fieldset
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        minWidth: 0,
        margin: 0,
        padding: 0,
        border: "none",
      }}
    >
      <legend style={{ padding: 0, marginBottom: 2, fontSize: "var(--fs-sm)" }}>
        Variables (asked for at Build)
      </legend>
      {variables.map((variable, index) => (
        <VariableRow key={index} variable={variable} index={index} canvas={canvas} />
      ))}
      <button
        className="fd-btn"
        data-testid={buildConfigTestIds.addVariable}
        style={{ alignSelf: "flex-start" }}
        onClick={() => canvas.getState().addVariable()}
      >
        Add variable
      </button>
    </fieldset>
  );
}

export function SessionSettingsSection({
  canvas,
  branches = noBranches,
}: {
  canvas: StoreApi<CanvasState>;
  branches?: StoreApi<BranchState> | undefined;
}) {
  const session = useStore(canvas, (state) => state.flow.session);
  const issues = useStore(canvas, (state) => selectSessionIssues(state.flow));
  const repo = session.buildConfig.repo ?? "";

  useEffect(() => {
    void branches.getState().load(repo);
  }, [branches, repo]);

  const commit: Commit = (path, value) => {
    if (typeof value === "string") {
      const { flow, updateSession } = canvas.getState();
      updateSession(applyField(flow.session, path, value));
    }
    return null;
  };
  const setRepo = (next: string) => canvas.getState().setRepo(next);
  const fieldFor = (field: FieldDescription) => {
    switch (field.path.join(".")) {
      case "buildConfig.repo":
        return (
          <RepoField
            key={field.testId}
            label={field.label}
            value={repo}
            testId={buildConfigTestIds.repo}
            browseTestId={buildConfigTestIds.repoBrowse}
            issue={issues["buildConfig.repo"]}
            onCommit={setRepo}
            onBrowse={() => void branches.getState().browse(setRepo)}
          />
        );
      case "buildConfig.base":
        return (
          <BranchField
            key={field.testId}
            label={field.label}
            repo={repo}
            value={session.buildConfig.base ?? ""}
            branches={branches}
            testId={buildConfigTestIds.base}
            infoTestId={buildConfigTestIds.baseInfo}
            errorTestId={buildConfigTestIds.branchesError}
            onChange={(base) => canvas.getState().setBase(base)}
          />
        );
      case "model":
        return (
          <ModelField
            key={field.testId}
            label={field.label}
            value={session.model}
            choices={modelChoices}
            testId={field.testId}
            onChange={(model) => commit(field.path, model)}
          />
        );
      default:
        return (
          <Field
            key={field.testId}
            field={field}
            values={session}
            commit={commit}
            issues={issues}
          />
        );
    }
  };
  return (
    <div
      data-testid="session-settings"
      style={{ display: "flex", flexDirection: "column", gap: 6, flexShrink: 0 }}
    >
      {sessionFields().map(fieldFor)}
      <VariablesField canvas={canvas} />
    </div>
  );
}
