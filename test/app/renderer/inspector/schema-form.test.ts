import { describe, expect, it } from "vitest";
import {
  applyField,
  sessionFields,
  settingsFields,
  type FieldDescription,
} from "../../../../src/app/renderer/inspector/schema-form.js";
import { controlTestIds } from "../../../../src/app/renderer/test-ids.js";
import { modelChoices, permissionModes } from "../../../../src/core/flow/choices.js";
import { Session } from "../../../../src/core/flow/schema.js";

const deepFreeze = <T>(value: T): T => {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

const summary = (field: FieldDescription) => ({
  control: field.control,
  path: field.path,
  testId: field.testId,
  ...(field.control === "select" ? { options: field.options } : {}),
});

const worktreeSession = (): Session =>
  deepFreeze({
    name: "build",
    buildConfig: { repo: "/r", base: "main" },
    model: "sonnet",
    frame: { nodes: ["A", "B"] },
  });

describe("sessionFields", () => {
  it("describes the session name, repository, base branch and model in schema order", () => {
    expect(sessionFields().map(summary)).toEqual([
      { control: "text", path: ["name"], testId: "session-name" },
      { control: "text", path: ["buildConfig", "repo"], testId: "session-build-config-repo" },
      { control: "text", path: ["buildConfig", "base"], testId: "session-build-config-base" },
      {
        control: "select",
        path: ["model"],
        testId: "session-model",
        options: modelChoices.map(({ value }) => value),
      },
    ]);
  });

  it("labels every field in plain words", () => {
    expect(sessionFields().map((field) => [field.testId, field.label])).toEqual([
      ["session-name", "Session name"],
      ["session-build-config-repo", "Repository"],
      ["session-build-config-base", "Start from branch"],
      ["session-model", "Model"],
    ]);
  });
});

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
  const ids = () => [...sessionFields(), ...settingsFields()].map(({ testId }) => testId);

  it.each(["budget", "allowed-tools", "connectors", "variables"])("has no %s field", (removed) => {
    expect(ids().filter((id) => id.includes(removed))).toEqual([]);
  });
});

describe("applyField", () => {
  const expectSession = (result: Session) => expect(Session.parse(result)).toEqual(result);

  it("sets the model and keeps every other key", () => {
    const before = worktreeSession();

    const after = applyField(before, ["model"], "haiku");

    expect(after).toEqual({ ...before, model: "haiku" });
    expect(after).not.toBe(before);
    expectSession(after);
  });

  it("sets a string inside the current working folder variant", () => {
    const before = worktreeSession();

    const after = applyField(before, ["buildConfig", "repo"], "/other");

    expect(after.buildConfig).toEqual({ repo: "/other", base: "main" });
    expect(after.frame).toEqual(before.frame);
    expectSession(after);
  });

  it("sets the base branch and keeps the repository", () => {
    const before = deepFreeze({ ...worktreeSession(), buildConfig: { repo: "/r" } });

    const after = applyField(before, ["buildConfig", "base"], "dev");

    expect(after.buildConfig).toEqual({ repo: "/r", base: "dev" });
    expectSession(after);
  });
});
