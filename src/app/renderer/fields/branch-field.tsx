import { useId } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import type { BranchState } from "../branch-store.js";
import { Icon } from "../icons.js";
import { branchSelect } from "./field-options.js";
import { fieldRowStyle, fieldStyle } from "./field-style.js";

const worktreeNote =
  "Every build makes its own git worktree from this branch. Flowdeck never works in the repository's own checkout.";

export function BranchField({
  label = "Start from branch",
  repo,
  value,
  branches,
  testId,
  infoTestId,
  errorTestId,
  onChange,
}: {
  label?: string;
  repo: string;
  value: string;
  branches: StoreApi<BranchState>;
  testId: string;
  infoTestId: string;
  errorTestId: string;
  onChange(base: string): void;
}) {
  const id = useId();
  const loaded = useStore(branches, (state) => state.byRepo[repo.trim()]);
  const { disabled, options, error } = branchSelect({
    repo,
    value,
    branches:
      loaded === undefined
        ? { repo: null, branches: null, error: null }
        : { repo: repo.trim(), ...loaded },
  });
  return (
    <div style={fieldStyle}>
      <div style={fieldRowStyle}>
        <label htmlFor={id}>{label}</label>
        <span
          className="fd-field-info"
          role="img"
          data-testid={infoTestId}
          title={worktreeNote}
          aria-label={worktreeNote}
        >
          <Icon name="info" />
        </span>
      </div>
      <select
        id={id}
        data-testid={testId}
        disabled={disabled}
        value={disabled ? "" : value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option
            key={option.value}
            value={option.value}
            disabled={!disabled && option.value === ""}
          >
            {option.label}
          </option>
        ))}
      </select>
      {error !== null && (
        <span className="fd-hint" data-testid={errorTestId} role="status">
          {error}
        </span>
      )}
    </div>
  );
}
