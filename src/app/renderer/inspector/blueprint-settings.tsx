import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import { modelChoices } from "../../../core/flow/choices.js";
import { FlowSettings } from "../../../core/flow/schema.js";
import type { CanvasState } from "../canvas/store.js";
import { controlTestIds } from "../test-ids.js";
import { ModelField } from "../fields/model-field.js";
import { Field, type Commit } from "./field.js";
import {
  assignField,
  settingsFields,
  sharedFieldFor,
  type FieldDescription,
} from "./schema-form.js";

export function BlueprintSettingsSection({ canvas }: { canvas: StoreApi<CanvasState> }) {
  const settings = useStore(canvas, (state) => state.flow.settings);

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
    </div>
  );
}
