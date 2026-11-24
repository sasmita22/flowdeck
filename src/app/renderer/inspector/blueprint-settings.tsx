import { useMemo } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import { modelChoices } from "../../../core/flow/choices.js";
import { FlowSettings } from "../../../core/flow/schema.js";
import type { Actions } from "../actions.js";
import type { CanvasState } from "../canvas/store.js";
import { controlTestIds } from "../test-ids.js";
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
