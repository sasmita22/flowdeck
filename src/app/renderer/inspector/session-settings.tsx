import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import type { CanvasState } from "../canvas/store.js";
import { Field, type Commit } from "./field.js";
import { applyField, describeFields, sessionSettingsSchema } from "./schema-form.js";

const fields = describeFields(sessionSettingsSchema);

export function SessionSettingsSection({ canvas }: { canvas: StoreApi<CanvasState> }) {
  const session = useStore(canvas, (state) => state.flow.session);
  const commit: Commit = (path, value) => {
    const { flow, updateSession } = canvas.getState();
    if (typeof value === "string") updateSession(applyField(flow.session, path, value));
    return null;
  };
  return (
    <div
      data-testid="session-settings"
      style={{ display: "flex", flexDirection: "column", gap: 6, flexShrink: 0 }}
    >
      {fields.map((field) => (
        <Field key={field.testId} field={field} values={session} commit={commit} />
      ))}
    </div>
  );
}
