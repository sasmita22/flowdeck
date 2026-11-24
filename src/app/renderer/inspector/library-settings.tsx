import { useEffect, type CSSProperties } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import { modelChoices } from "../../../core/flow/choices.js";
import type { LibrarySession } from "../../../core/flow/libraries.js";
import type { BranchState } from "../branch-store.js";
import { selectNodeIssues, selectSelectedNode, type CanvasState } from "../canvas/store.js";
import { BranchField } from "../fields/branch-field.js";
import { noBranches } from "./container-settings.js";
import { ModelField } from "../fields/model-field.js";
import { RepoField } from "../fields/repo-field.js";
import { libraryCaption } from "../nodes/library-caption.js";
import { libraryTestIds, type LibraryOverrideField } from "../test-ids.js";
import {
  overriddenLibrary,
  renamedLibrary,
  sessionValue,
  type LibraryNode,
} from "./library-form.js";

const headingStyle: CSSProperties = { fontSize: "var(--fs-md)", margin: "12px 0 4px" };

const labelStyle: CSSProperties = { display: "flex", flexDirection: "column", gap: 2 };

const selectedLibrary = (state: CanvasState): LibraryNode | null => {
  const node = selectSelectedNode(state);
  return node?.type === "library" ? node : null;
};

function SessionOverrides({
  canvas,
  node,
  session,
  branches,
}: {
  canvas: StoreApi<CanvasState>;
  node: LibraryNode;
  session: LibrarySession;
  branches: StoreApi<BranchState>;
}) {
  const change = (field: LibraryOverrideField) => (value: string) => {
    const current = selectedLibrary(canvas.getState());
    if (current !== null) {
      canvas.getState().updateNode(overriddenLibrary(current, session, field, value));
    }
  };
  const repo = sessionValue(node, session, "repo");

  useEffect(() => {
    void branches.getState().load(repo);
  }, [branches, repo]);

  const repoTestId = libraryTestIds.override(session.id, "repo");
  const branchTestId = libraryTestIds.override(session.id, "branch");
  return (
    <fieldset data-testid={`library-session-${session.id}`} style={labelStyle}>
      <legend>Session “{session.name}”</legend>
      <RepoField
        value={repo}
        testId={repoTestId}
        browseTestId={`${repoTestId}-browse`}
        onCommit={change("repo")}
        onBrowse={() => void branches.getState().browse(change("repo"))}
      />
      <BranchField
        repo={repo}
        value={sessionValue(node, session, "branch")}
        branches={branches}
        testId={branchTestId}
        infoTestId={`${branchTestId}-info`}
        errorTestId={`${branchTestId}-error`}
        onChange={change("branch")}
      />
      <ModelField
        label="Model"
        value={sessionValue(node, session, "model")}
        choices={modelChoices}
        testId={libraryTestIds.override(session.id, "model")}
        onChange={change("model")}
      />
    </fieldset>
  );
}

export function LibrarySettings({
  canvas,
  branches,
}: {
  canvas: StoreApi<CanvasState>;
  branches?: StoreApi<BranchState> | undefined;
}) {
  const node = useStore(canvas, selectedLibrary);
  const libraries = useStore(canvas, (state) => state.libraries);
  const flow = useStore(canvas, (state) => state.flow);
  if (node === null) return null;
  const library = libraries(node.settings.libraryId);
  const problems = selectNodeIssues(flow, libraries)[node.id] ?? [];
  const rename = (label: string) => {
    const current = selectedLibrary(canvas.getState());
    if (current !== null && label !== current.settings.label) {
      canvas.getState().updateNode(renamedLibrary(current, label));
    }
  };
  return (
    <section
      key={node.id}
      data-testid="node-settings"
      aria-label="Library"
      style={{ display: "flex", flexDirection: "column", gap: 6, flexShrink: 0 }}
    >
      <h2 style={headingStyle}>Library</h2>
      <span className="fd-palette-description">
        {libraryCaption(node.settings.libraryId, libraries)}
      </span>
      {problems.length > 0 && (
        <ul className="fd-node-problems" data-testid="node-problems" aria-label="Problems">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}
      <label style={labelStyle}>
        Label
        <input
          key={node.settings.label}
          data-testid={libraryTestIds.label}
          type="text"
          defaultValue={node.settings.label}
          onBlur={(event) => rename(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
        />
      </label>
      {library?.kind === "session-library" &&
        library.sessions.map((session) => (
          <SessionOverrides
            key={session.id}
            canvas={canvas}
            node={node}
            session={session}
            branches={branches ?? noBranches}
          />
        ))}
    </section>
  );
}
