import { useEffect, type CSSProperties } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import type { Variable } from "../../../core/flow/schema.js";
import type { BranchState } from "../branch-store.js";
import { selectSessionIssues, type CanvasState } from "../canvas/store.js";
import { buildConfigTestIds } from "../test-ids.js";
import { Field, type Commit } from "./field.js";
import { applyField, sessionFields } from "./schema-form.js";

const noBranches: StoreApi<Pick<BranchState, "branches" | "error" | "load">> = {
  getState: () => ({ branches: null, error: null, load: async () => undefined }),
  getInitialState: () => ({ branches: null, error: null, load: async () => undefined }),
  setState: () => undefined,
  subscribe: () => () => undefined,
};

const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
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
        style={{ flex: 1, minWidth: 0 }}
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
          style={{ flex: 1, minWidth: 0 }}
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
  branches?: StoreApi<Pick<BranchState, "branches" | "error" | "load">> | undefined;
}) {
  const session = useStore(canvas, (state) => state.flow.session);
  const issues = useStore(canvas, (state) => selectSessionIssues(state.flow));
  const known = useStore(branches, (state) => state.branches);
  const branchError = useStore(branches, (state) => state.error);
  const repo = session.buildConfig.repo ?? "";

  useEffect(() => {
    void branches.getState().load(repo);
  }, [branches, repo]);

  const fields = sessionFields(known ?? undefined);
  const commit: Commit = (path, value) => {
    if (typeof value !== "string") return null;
    const { flow, updateSession, setRepo, setBase } = canvas.getState();
    const key = path.join(".");
    if (key === "buildConfig.repo") setRepo(value);
    else if (key === "buildConfig.base") setBase(value);
    else updateSession(applyField(flow.session, path, value));
    return null;
  };
  return (
    <div
      data-testid="session-settings"
      style={{ display: "flex", flexDirection: "column", gap: 6, flexShrink: 0 }}
    >
      {fields.map((field) => (
        <Field key={field.testId} field={field} values={session} commit={commit} issues={issues} />
      ))}
      {branchError !== null && (
        <span className="fd-hint" data-testid="session-branches-error" role="status">
          {branchError}. Type the branch to start from instead.
        </span>
      )}
      <VariablesField canvas={canvas} />
    </div>
  );
}
