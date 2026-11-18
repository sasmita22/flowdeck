import { useEffect } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import { modelChoices } from "../../../core/flow/choices.js";
import type { FlowContainer } from "../../../core/flow/schema.js";
import type { BranchState } from "../branch-store.js";
import type { FlowContainerPatch } from "../canvas/commands.js";
import { selectFlowContainerIssues, type CanvasState } from "../canvas/store.js";
import { BranchField } from "../fields/branch-field.js";
import { issueStyle } from "../fields/field-style.js";
import { ModelField } from "../fields/model-field.js";
import { RepoField } from "../fields/repo-field.js";
import { containerTestIds } from "../test-ids.js";
import { Field, type Commit } from "./field.js";
import { containerFields, sharedFieldFor, type FieldDescription } from "./schema-form.js";

const noBranchState: BranchState = {
  byRepo: {},
  load: async () => undefined,
  browse: async () => undefined,
};

const noBranches: StoreApi<BranchState> = {
  getState: () => noBranchState,
  getInitialState: () => noBranchState,
  setState: () => undefined,
  subscribe: () => () => undefined,
};

function FieldIssue({ testId, text }: { testId: string; text: string | undefined }) {
  if (text === undefined) return null;
  return (
    <span data-testid={`${testId}-issue`} role="status" style={issueStyle}>
      {text}
    </span>
  );
}

const sessionSetting = (container: FlowContainer | undefined, key: "repo" | "branch"): string =>
  container?.kind === "session" ? container[key] : "";

export function ContainerSettings({
  canvas,
  containerId,
  branches = noBranches,
}: {
  canvas: StoreApi<CanvasState>;
  containerId: string;
  branches?: StoreApi<BranchState> | undefined;
}) {
  const container = useStore(canvas, (state) =>
    state.flow.containers.find(({ id }) => id === containerId),
  );
  const flow = useStore(canvas, (state) => state.flow);
  const issues = selectFlowContainerIssues(flow, containerId);
  const repo = sessionSetting(container, "repo");

  useEffect(() => {
    void branches.getState().load(repo);
  }, [branches, repo]);

  if (container === undefined) return null;

  const update = (patch: FlowContainerPatch) =>
    canvas.getState().updateFlowContainer(container.id, patch);
  const commitName: Commit = (path, value) => {
    if (typeof value === "string" && path.join(".") === "name") update({ name: value });
    return null;
  };
  const setRepo = (next: string) => update({ repo: next });

  const fieldFor = (field: FieldDescription) => {
    switch (sharedFieldFor(field.path)) {
      case "repo": {
        const testId = containerTestIds.field(container.id, "repo");
        return (
          <RepoField
            key={field.testId}
            label={field.label}
            value={repo}
            testId={testId}
            browseTestId={`${testId}-browse`}
            issue={issues["repo"]}
            onCommit={setRepo}
            onBrowse={() => void branches.getState().browse(setRepo)}
          />
        );
      }
      case "branch": {
        const testId = containerTestIds.field(container.id, "branch");
        return (
          <div key={field.testId}>
            <BranchField
              label={field.label}
              repo={repo}
              value={sessionSetting(container, "branch")}
              branches={branches}
              testId={testId}
              infoTestId={`${testId}-info`}
              errorTestId={`${testId}-error`}
              onChange={(branch) => update({ branch })}
            />
            <FieldIssue testId={testId} text={issues["branch"]} />
          </div>
        );
      }
      case "model": {
        const testId = containerTestIds.field(container.id, "model");
        return (
          <div key={field.testId}>
            <ModelField
              label={field.label}
              value={container.model}
              choices={modelChoices}
              testId={testId}
              onChange={(model) => update({ model })}
            />
            <FieldIssue testId={testId} text={issues["model"]} />
          </div>
        );
      }
      default:
        return (
          <Field
            key={field.testId}
            field={field}
            values={container}
            commit={commitName}
            issues={issues}
          />
        );
    }
  };

  return (
    <div
      data-testid={`container-settings-${container.id}`}
      style={{ display: "flex", flexDirection: "column", gap: 6, flexShrink: 0 }}
    >
      {containerFields(container).map(fieldFor)}
    </div>
  );
}
