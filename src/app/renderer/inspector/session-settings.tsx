import { useEffect } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import type { BranchState } from "../branch-store.js";
import { selectSessionIssues, type CanvasState } from "../canvas/store.js";
import { Field, type Commit } from "./field.js";
import { applyField, sessionFields } from "./schema-form.js";

const noBranches: StoreApi<Pick<BranchState, "branches" | "error" | "load">> = {
  getState: () => ({ branches: null, error: null, load: async () => undefined }),
  getInitialState: () => ({ branches: null, error: null, load: async () => undefined }),
  setState: () => undefined,
  subscribe: () => () => undefined,
};

export function SessionSettingsSection({
  canvas,
  branches = noBranches,
}: {
  canvas: StoreApi<CanvasState>;
  branches?: StoreApi<Pick<BranchState, "branches" | "error" | "load">> | undefined;
}) {
  const session = useStore(canvas, (state) => state.flow.session);
  const issues = useStore(canvas, (state) => selectSessionIssues(state.flow));
  const known = useStore(branches, (state) => state.branches);
  const branchError = useStore(branches, (state) => state.error);
  const folder = session.workingFolder;
  const repo = folder.kind === "worktree" ? (folder.repo ?? "") : "";

  useEffect(() => {
    if (folder.kind === "worktree") void branches.getState().load(repo);
  }, [branches, folder.kind, repo]);

  const fields = sessionFields(folder.kind === "worktree" && known !== null ? known : undefined);
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
        <Field key={field.testId} field={field} values={session} commit={commit} issues={issues} />
      ))}
      {folder.kind === "worktree" && branchError !== null && (
        <span className="fd-hint" data-testid="session-branches-error" role="status">
          {branchError}. Type the branch to start from instead.
        </span>
      )}
    </div>
  );
}
