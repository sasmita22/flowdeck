import { useId } from "react";
import type { Choice } from "../../../core/flow/choices.js";
import { withCurrent } from "./field-options.js";
import { fieldStyle } from "./field-style.js";

export function ModelField({
  label,
  value,
  choices,
  testId,
  onChange,
}: {
  label: string;
  value: string;
  choices: readonly Choice[];
  testId: string;
  onChange(model: string): void;
}) {
  const id = useId();
  return (
    <div style={fieldStyle}>
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        data-testid={testId}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {withCurrent(choices, value).map((choice) => (
          <option key={choice.value} value={choice.value}>
            {choice.label}
          </option>
        ))}
      </select>
    </div>
  );
}
