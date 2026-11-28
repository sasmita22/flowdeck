import { useMemo } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import { modelChoices } from "../../../core/flow/choices.js";
import { FlowSettings } from "../../../core/flow/schema.js";
import { blueprintVariables, type OwnedVariable } from "../../../core/flow/variables.js";
import type { Actions } from "../actions.js";
import type { CanvasState } from "../canvas/store.js";
import { blueprintVariableTestIds, controlTestIds } from "../test-ids.js";
import { ModelField } from "../fields/model-field.js";
import { UsedByList } from "../used-by-list.js";
import { libraryUsers } from "../used-by.js";
import { Field, type Commit } from "./field.js";
import {
  assignField,
  settingsFields,
  sharedFieldFor,
  type FieldDescription,
} from "./schema-form.js";

const listStyle = {
  margin: 0,
  padding: 0,
  listStyle: "none",
  display: "flex",
  flexDirection: "column",
  gap: 2,
} as const;

const definedText = ({ definedBy }: OwnedVariable): string =>
  definedBy === undefined ? "not defined" : `defined by ${definedBy.join(", ")}`;

function VariablesList({ variables }: { variables: readonly OwnedVariable[] }) {
  return (
    <ul data-testid={blueprintVariableTestIds.list} aria-label="Variables" style={listStyle}>
      {variables.map((variable) => (
        <li key={variable.name} data-testid={blueprintVariableTestIds.variable(variable.name)}>
          <code>{variable.name}</code> — {definedText(variable)}
        </li>
      ))}
    </ul>
  );
}

export function BlueprintSettingsSection({
  canvas,
  actions,
}: {
  canvas: StoreApi<CanvasState>;
  actions: Pick<Actions, "openBlueprint"> | undefined;
}) {
  const settings = useStore(canvas, (state) => state.flow.settings);
  const summaries = useStore(canvas, (state) => state.librarySummaries);
  const openFlowId = useStore(canvas, (state) => state.openFlowId);
  const flow = useStore(canvas, (state) => state.flow);
  const libraries = useStore(canvas, (state) => state.libraries);
  const variables = useMemo(() => blueprintVariables(flow, libraries).owned, [flow, libraries]);
  const users = useMemo(
    () => libraryUsers(summaries, openFlowId ?? undefined),
    [summaries, openFlowId],
  );

  const commit: Commit = (path, value) => {
    const { flow, updateSettings } = canvas.getState();
    updateSettings(assignField(FlowSettings, flow.settings, path, value) as FlowSettings);
    return null;
  };
  const fieldFor = (field: FieldDescription) =>
    sharedFieldFor(field.path) === "model" ? (
      <ModelField
        key={field.testId}
        label={field.label}
        value={settings.buildModel}
        choices={modelChoices}
        testId={field.testId}
        onChange={(model) => commit(field.path, model)}
      />
    ) : (
      <Field key={field.testId} field={field} values={settings} commit={commit} />
    );

  return (
    <div
      data-testid={controlTestIds.blueprintSettings}
      style={{ display: "flex", flexDirection: "column", gap: 6, flexShrink: 0 }}
    >
      {settingsFields().map(fieldFor)}
      {variables.length > 0 && (
        <>
          <h3 style={{ fontSize: "var(--fs-sm)", margin: "8px 0 0" }}>Variables</h3>
          <VariablesList variables={variables} />
        </>
      )}
      {users !== null && openFlowId !== null && (
        <>
          <h3 style={{ fontSize: "var(--fs-sm)", margin: "8px 0 0" }}>Used by</h3>
          <UsedByList
            scope="settings"
            libraryId={openFlowId}
            users={users}
            onOpen={(flowId) => void actions?.openBlueprint(flowId)}
          />
        </>
      )}
    </div>
  );
}
