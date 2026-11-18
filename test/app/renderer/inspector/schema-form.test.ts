import { describe, expect, it } from "vitest";
import {
  containerFields,
  settingsFields,
  sharedFieldFor,
  type FieldDescription,
} from "../../../../src/app/renderer/inspector/schema-form.js";
import { controlTestIds } from "../../../../src/app/renderer/test-ids.js";
import { modelChoices, permissionModes } from "../../../../src/core/flow/choices.js";
import type { SessionContainer, WorkspaceContainer } from "../../../../src/core/flow/schema.js";

const summary = (field: FieldDescription) => ({
  control: field.control,
  path: field.path,
  testId: field.testId,
  ...(field.control === "select" ? { options: field.options } : {}),
});

const workspace: WorkspaceContainer = {
  id: "workspace-1",
  kind: "workspace",
  model: "sonnet",
  nodes: [],
};

const session: SessionContainer = {
  id: "session-2",
  kind: "session",
  name: "web",
  repo: "/code/blog",
  branch: "main",
  model: "sonnet",
  nodes: [],
};

const modelOptions = modelChoices.map(({ value }) => value);

describe("settingsFields", () => {
  it("describes the build model and the permission mode, in schema order", () => {
    expect(settingsFields().map(summary)).toEqual([
      {
        control: "select",
        path: ["buildModel"],
        testId: "settings-build-model",
        options: modelChoices.map(({ value }) => value),
      },
      {
        control: "select",
        path: ["permissionMode"],
        testId: "settings-permission-mode",
        options: permissionModes.map(({ value }) => value),
      },
    ]);
  });

  it("labels and names each choice in plain words", () => {
    const [buildModel, permission] = settingsFields();
    if (buildModel?.control !== "select" || permission?.control !== "select") {
      throw new Error("expected selects");
    }

    expect([buildModel.label, permission.label]).toEqual(["Build model", "Permission mode"]);
    expect(buildModel.optionLabels["sonnet"]).toBe("Sonnet (latest)");
    expect(permission.optionLabels["acceptEdits"]).toBe("Accept file edits without asking");
  });

  it("gives the build model a test id of its own, apart from the Build dialog's", () => {
    const [buildModel] = settingsFields();

    expect(buildModel?.testId).not.toBe(controlTestIds.buildModel);
  });
});

describe("the Blueprint settings form", () => {
  it("keeps only the build model and the permission mode", () => {
    expect(settingsFields().map(({ path }) => path.join("."))).toEqual([
      "buildModel",
      "permissionMode",
    ]);
  });

  it.each(["budget", "allowed-tools", "connectors", "variables"])("has no %s field", (removed) => {
    const ids = [...settingsFields(), ...containerFields(workspace), ...containerFields(session)];

    expect(ids.map(({ testId }) => testId).filter((id) => id.includes(removed))).toEqual([]);
  });
});

describe("containerFields", () => {
  it("describes a workspace by its model alone, named by the container", () => {
    expect(containerFields(workspace).map(summary)).toEqual([
      {
        control: "select",
        path: ["model"],
        testId: "container-workspace-1-model",
        options: modelOptions,
      },
    ]);
  });

  it("describes a session by its name, repository, branch and model, named by the container", () => {
    expect(containerFields(session).map(summary)).toEqual([
      { control: "text", path: ["name"], testId: "container-session-2-name" },
      { control: "text", path: ["repo"], testId: "container-session-2-repo" },
      { control: "text", path: ["branch"], testId: "container-session-2-branch" },
      {
        control: "select",
        path: ["model"],
        testId: "container-session-2-model",
        options: modelOptions,
      },
    ]);
  });

  it("labels every field in plain words", () => {
    expect(containerFields(session).every(({ label }) => label.trim() !== "")).toBe(true);
  });
});

describe("sharedFieldFor", () => {
  it("routes a container's model, repository and branch to the shared fields", () => {
    expect(containerFields(session).map(({ path }) => sharedFieldFor(path))).toEqual([
      undefined,
      "repo",
      "branch",
      "model",
    ]);
    expect(containerFields(workspace).map(({ path }) => sharedFieldFor(path))).toEqual(["model"]);
  });

  it("routes the blueprint's build model to the shared model field", () => {
    expect(settingsFields().map(({ path }) => sharedFieldFor(path))).toEqual(["model", undefined]);
  });
});
