import { useId, type KeyboardEvent } from "react";
import { Icon } from "../icons.js";
import { fieldRowStyle, fieldStyle, issueStyle } from "./field-style.js";

export function RepoField({
  label = "Repository",
  value,
  testId,
  browseTestId,
  issue,
  onCommit,
  onBrowse,
}: {
  label?: string;
  value: string;
  testId: string;
  browseTestId: string;
  issue?: string | undefined;
  onCommit(repo: string): void;
  onBrowse(): void;
}) {
  const id = useId();
  const commit = (next: string) => {
    if (next !== value) onCommit(next);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    event.currentTarget.blur();
  };
  return (
    <div style={fieldStyle}>
      <label htmlFor={id}>{label}</label>
      <div style={fieldRowStyle}>
        <input
          key={value}
          id={id}
          type="text"
          data-testid={testId}
          defaultValue={value}
          style={{ flex: 1, minWidth: 0 }}
          onBlur={(event) => commit(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <button
          type="button"
          className="fd-btn fd-icon-btn"
          data-testid={browseTestId}
          title="Browse for a folder"
          aria-label="Browse for a folder"
          onClick={onBrowse}
        >
          <Icon name="folder" />
        </button>
      </div>
      {issue !== undefined && (
        <span data-testid={`${testId}-issue`} role="status" style={issueStyle}>
          {issue}
        </span>
      )}
    </div>
  );
}
