import type { CSSProperties } from "react";
import type { FoundVariable } from "../../../core/flow/variables.js";

const textStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  fontSize: "var(--fs-sm)",
};

const switchStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  fontSize: "var(--fs-sm)",
};

export function VariableField({
  variable,
  value,
  testId,
  onChange,
}: {
  variable: Pick<FoundVariable, "name" | "kind">;
  value: string | boolean | undefined;
  testId: string;
  onChange(value: string | boolean): void;
}) {
  return variable.kind === "yes-no" ? (
    <label style={switchStyle}>
      <input
        type="checkbox"
        role="switch"
        data-testid={testId}
        checked={value === true}
        onChange={(event) => onChange(event.target.checked)}
      />
      {variable.name}
    </label>
  ) : (
    <label style={textStyle}>
      {variable.name}
      <input
        data-testid={testId}
        value={typeof value === "string" ? value : ""}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}
