import { useState, type CSSProperties, type KeyboardEvent } from "react";
import { addFlag, removeFlag, renameFlag, setFlag } from "./node-form.js";
import type { FieldDescription, FieldValue } from "./schema-form.js";

type Path = readonly string[];

export type Commit = (path: Path, value: FieldValue) => string | null;

type Flags = Readonly<Record<string, string | number | boolean>>;

const labelStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
  fontSize: "var(--fs-sm)",
};

const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  fontSize: "var(--fs-sm)",
};

const issueStyle: CSSProperties = {
  color: "var(--warn)",
  fontSize: "var(--fs-xs)",
  lineHeight: 1.35,
};

export const valueAt = (root: unknown, path: Path): unknown =>
  path.reduce<unknown>((value, key) => (value as Record<string, unknown> | undefined)?.[key], root);

const textOf = (value: unknown) =>
  Array.isArray(value)
    ? value.join("\n")
    : typeof value === "string" || typeof value === "number"
      ? String(value)
      : "";

const blurOnEnter = (event: KeyboardEvent<HTMLInputElement>) => {
  if (event.key === "Enter") event.currentTarget.blur();
};

function Issue({ testId, text }: { testId: string; text: string | undefined }) {
  if (text === undefined) return null;
  return (
    <span data-testid={`${testId}-issue`} role="status" style={issueStyle}>
      {text}
    </span>
  );
}

function FlagsField({
  field,
  flags,
  commit,
}: {
  field: FieldDescription;
  flags: Flags;
  commit: Commit;
}) {
  const set = (next: Flags) => commit(field.path, next);
  return (
    <fieldset
      data-testid={field.testId}
      style={{ ...labelStyle, gap: 4, margin: 0, padding: 0, border: "none", minWidth: 0 }}
    >
      <legend style={{ padding: 0, marginBottom: 2 }}>{field.label}</legend>
      {Object.entries(flags).map(([name, value], index) => (
        <div key={`${index}-${name}`} style={rowStyle}>
          {typeof value === "boolean" ? (
            <input
              type="checkbox"
              data-testid={`${field.testId}-on-${index}`}
              aria-label={`${name} on by default`}
              checked={value}
              onChange={(event) => set(setFlag(flags, name, event.target.checked))}
            />
          ) : (
            <span title="Not a switch">{String(value)}</span>
          )}
          <input
            type="text"
            data-testid={`${field.testId}-name-${index}`}
            aria-label="Flag name"
            defaultValue={name}
            style={{ flex: 1, minWidth: 0 }}
            onBlur={(event) => {
              const next = renameFlag(flags, name, event.target.value);
              if (next === flags) event.target.value = name;
              else set(next);
            }}
            onKeyDown={blurOnEnter}
          />
          <button
            className="fd-btn"
            data-testid={`${field.testId}-remove-${index}`}
            onClick={() => set(removeFlag(flags, name))}
          >
            Remove
          </button>
        </div>
      ))}
      <button
        className="fd-btn"
        data-testid={`${field.testId}-add`}
        style={{ alignSelf: "flex-start" }}
        onClick={() => set(addFlag(flags))}
      >
        Add flag
      </button>
    </fieldset>
  );
}

export function Field({
  field,
  values,
  commit,
  issues = {},
}: {
  field: FieldDescription;
  values: unknown;
  commit: Commit;
  issues?: Readonly<Record<string, string>>;
}) {
  const [refused, setRefused] = useState<{ reason: string; stored: string | undefined } | null>(
    null,
  );
  const [attempt, setAttempt] = useState(0);
  const raw =
    valueAt(values, field.path) ?? (field.control === "select" ? field.fallback : undefined);
  const value = textOf(raw);
  const stored = JSON.stringify(raw);
  const stillRefused = refused !== null && refused.stored === stored ? refused.reason : undefined;
  const issue = stillRefused ?? issues[field.path.join(".")];
  const send = (next: FieldValue) => {
    const reason = commit(field.path, next);
    setRefused(reason === null ? null : { reason, stored });
    if (reason !== null) setAttempt((count) => count + 1);
  };
  const sendIfChanged = (next: string) => {
    if (next !== value) send(next);
    else setRefused(null);
  };
  const key = `${value}#${attempt}`;

  if (field.control === "select") {
    return (
      <>
        <label style={labelStyle}>
          {field.label}
          <select data-testid={field.testId} value={value} onChange={(e) => send(e.target.value)}>
            {!field.options.includes(value) &&
              (value === "" ? (
                <option value="" disabled>
                  Choose…
                </option>
              ) : (
                <option value={value}>{value}</option>
              ))}
            {field.options.map((option) => (
              <option key={option} value={option}>
                {field.optionLabels[option]}
              </option>
            ))}
          </select>
        </label>
        <Issue testId={field.testId} text={issue} />
        {(field.variants[value] ?? []).map((child) => (
          <Field key={child.testId} field={child} values={values} commit={commit} issues={issues} />
        ))}
      </>
    );
  }
  if (field.control === "toggle") {
    return (
      <>
        <label style={rowStyle}>
          <input
            type="checkbox"
            data-testid={field.testId}
            checked={raw === true}
            onChange={(event) => send(event.target.checked)}
          />
          {field.label}
        </label>
        <Issue testId={field.testId} text={issue} />
      </>
    );
  }
  if (field.control === "flags") {
    return (
      <>
        <FlagsField field={field} flags={(raw ?? {}) as Flags} commit={commit} />
        <Issue testId={field.testId} text={issue} />
      </>
    );
  }
  if (field.control === "list" || field.control === "multiline") {
    return (
      <>
        <label style={labelStyle}>
          {field.label}
          <textarea
            key={key}
            data-testid={field.testId}
            defaultValue={value}
            placeholder={field.placeholder}
            rows={3}
            style={{ font: "inherit" }}
            onBlur={(event) => sendIfChanged(event.target.value)}
          />
        </label>
        <Issue testId={field.testId} text={issue} />
      </>
    );
  }
  const numeric = field.control === "number";
  return (
    <>
      <label style={labelStyle}>
        {field.label}
        <input
          key={key}
          data-testid={field.testId}
          type={numeric ? "number" : "text"}
          min={numeric ? "0" : undefined}
          step={numeric ? "any" : undefined}
          defaultValue={value}
          placeholder={field.placeholder}
          onBlur={(event) => sendIfChanged(event.target.value)}
          onKeyDown={blurOnEnter}
        />
      </label>
      <Issue testId={field.testId} text={issue} />
    </>
  );
}
