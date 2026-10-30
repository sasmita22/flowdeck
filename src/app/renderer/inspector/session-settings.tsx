import type { CSSProperties } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import type { Session } from "../../../core/flow/schema.js";
import type { CanvasState } from "../canvas/store.js";
import {
  applyField,
  describeFields,
  sessionSettingsSchema,
  type FieldDescription,
} from "./schema-form.js";

const fields = describeFields(sessionSettingsSchema);

const labelStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
  fontSize: 12,
};

const valueAt = (session: Session, path: readonly string[]): unknown =>
  path.reduce<unknown>(
    (value, key) => (value as Record<string, unknown> | undefined)?.[key],
    session,
  );

const textOf = (value: unknown) =>
  Array.isArray(value) ? value.join("\n") : typeof value === "string" ? value : "";

function Field({
  field,
  session,
  commit,
}: {
  field: FieldDescription;
  session: Session;
  commit: (path: readonly string[], value: string) => void;
}) {
  const value = textOf(valueAt(session, field.path));
  const label = field.path.at(-1);
  const commitIfChanged = (next: string) => {
    if (next !== value) commit(field.path, next);
  };
  if (field.control === "select") {
    return (
      <>
        <label style={labelStyle}>
          {label}
          <select
            data-testid={field.testId}
            value={value}
            onChange={(event) => commit(field.path, event.target.value)}
          >
            {field.options.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        {(field.variants[value] ?? []).map((child) => (
          <Field key={child.testId} field={child} session={session} commit={commit} />
        ))}
      </>
    );
  }
  if (field.control === "list") {
    return (
      <label style={labelStyle}>
        {label}
        <textarea
          key={value}
          data-testid={field.testId}
          defaultValue={value}
          rows={3}
          onBlur={(event) => commitIfChanged(event.target.value)}
        />
      </label>
    );
  }
  return (
    <label style={labelStyle}>
      {label}
      <input
        key={value}
        data-testid={field.testId}
        type="text"
        defaultValue={value}
        onBlur={(event) => commitIfChanged(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
      />
    </label>
  );
}

export function SessionSettingsSection({ canvas }: { canvas: StoreApi<CanvasState> }) {
  const session = useStore(canvas, (state) => state.flow.session);
  const commit = (path: readonly string[], value: string) => {
    const { flow, updateSession } = canvas.getState();
    updateSession(applyField(flow.session, path, value));
  };
  return (
    <div
      data-testid="session-settings"
      style={{ display: "flex", flexDirection: "column", gap: 6, flexShrink: 0 }}
    >
      {fields.map((field) => (
        <Field key={field.testId} field={field} session={session} commit={commit} />
      ))}
    </div>
  );
}
