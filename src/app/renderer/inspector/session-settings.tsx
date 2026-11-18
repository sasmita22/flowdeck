import { useEffect } from "react";
import { useStore } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import { modelChoices } from "../../../core/flow/choices.js";
import { FlowSettings } from "../../../core/flow/schema.js";
import type { BranchState } from "../branch-store.js";
import { selectSessionIssues, type CanvasState } from "../canvas/store.js";
import { BranchField } from "../fields/branch-field.js";
import { ModelField } from "../fields/model-field.js";
import { RepoField } from "../fields/repo-field.js";
import { buildConfigTestIds } from "../test-ids.js";
import { Field, type Commit } from "./field.js";
import {
  applyField,
  assignField,
  sessionFields,
  settingsFields,
  type FieldDescription,
} from "./schema-form.js";

const noBranchState: BranchState = {
  repo: null,
  branches: null,
  error: null,
  load: async () => undefined,
  browse: async () => undefined,
};

const noBranches: StoreApi<BranchState> = {
  getState: () => noBranchState,
  getInitialState: () => noBranchState,
  setState: () => undefined,
  subscribe: () => () => undefined,
};

export function SessionSettingsSection({
  canvas,
  branches = noBranches,
}: {
  canvas: StoreApi<CanvasState>;
  branches?: StoreApi<BranchState> | undefined;
}) {
  const session = useStore(canvas, (state) => state.flow.session);
  const settings = useStore(canvas, (state) => state.flow.settings);
  const issues = useStore(canvas, (state) => selectSessionIssues(state.flow));
  const repo = session.buildConfig.repo ?? "";

  useEffect(() => {
    void branches.getState().load(repo);
  }, [branches, repo]);

  const commit: Commit = (path, value) => {
    if (typeof value === "string") {
      const { flow, updateSession } = canvas.getState();
      updateSession(applyField(flow.session, path, value));
    }
    return null;
  };
  const commitSetting: Commit = (path, value) => {
    const { flow, updateSettings } = canvas.getState();
    updateSettings(assignField(FlowSettings, flow.settings, path, value) as FlowSettings);
    return null;
  };
  const settingFor = (field: FieldDescription) =>
    field.path.join(".") === "buildModel" ? (
      <ModelField
        key={field.testId}
        label={field.label}
        value={settings.buildModel}
        choices={modelChoices}
        testId={field.testId}
        onChange={(model) => commitSetting(field.path, model)}
      />
    ) : (
      <Field key={field.testId} field={field} values={settings} commit={commitSetting} />
    );
  const setRepo = (next: string) => canvas.getState().setRepo(next);
  const fieldFor = (field: FieldDescription) => {
    switch (field.path.join(".")) {
      case "buildConfig.repo":
        return (
          <RepoField
            key={field.testId}
            label={field.label}
            value={repo}
            testId={buildConfigTestIds.repo}
            browseTestId={buildConfigTestIds.repoBrowse}
            issue={issues["buildConfig.repo"]}
            onCommit={setRepo}
            onBrowse={() => void branches.getState().browse(setRepo)}
          />
        );
      case "buildConfig.base":
        return (
          <BranchField
            key={field.testId}
            label={field.label}
            repo={repo}
            value={session.buildConfig.base ?? ""}
            branches={branches}
            testId={buildConfigTestIds.base}
            infoTestId={buildConfigTestIds.baseInfo}
            errorTestId={buildConfigTestIds.branchesError}
            onChange={(base) => canvas.getState().setBase(base)}
          />
        );
      case "model":
        return (
          <ModelField
            key={field.testId}
            label={field.label}
            value={session.model}
            choices={modelChoices}
            testId={field.testId}
            onChange={(model) => commit(field.path, model)}
          />
        );
      default:
        return (
          <Field
            key={field.testId}
            field={field}
            values={session}
            commit={commit}
            issues={issues}
          />
        );
    }
  };
  return (
    <div
      data-testid="session-settings"
      style={{ display: "flex", flexDirection: "column", gap: 6, flexShrink: 0 }}
    >
      {sessionFields().map(fieldFor)}
      {settingsFields().map(settingFor)}
    </div>
  );
}
