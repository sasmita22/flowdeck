import { describe, expect, it } from "vitest";
import {
  applyField,
  sessionFields,
  withChoices,
  yesNoChoices,
  type FieldDescription,
} from "../../../../src/app/renderer/inspector/schema-form.js";
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
    buildConfig: { repo: "/r", base: "main", variables: [] },
    model: "sonnet",
    allowedTools: ["Read"],
    permissionMode: "default",
    connectors: [],
    frame: { nodes: ["A", "B"] },
  });

describe("describeFields", () => {
  it("describes name, repository, base branch, model, tools, permission mode and budget in schema order", () => {
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
      { control: "list", path: ["allowedTools"], testId: "session-allowed-tools" },
      {
        control: "select",
        path: ["permissionMode"],
        testId: "session-permission-mode",
        options: permissionModes.map(({ value }) => value),
      },
      { control: "number", path: ["budget"], testId: "session-budget" },
    ]);
  });

  it("names each model and permission mode in plain words", () => {
    const [, , , model, , permission] = sessionFields();
    if (model?.control !== "select" || permission?.control !== "select") {
      throw new Error("expected selects");
    }

    expect(model.optionLabels["sonnet"]).toBe("Sonnet (latest)");
    expect(permission.optionLabels["acceptEdits"]).toBe("Accept file edits without asking");
  });

  it("labels every field in plain words", () => {
    expect(sessionFields().map((field) => [field.testId, field.label])).toEqual([
      ["session-name", "Session name"],
      ["session-build-config-repo", "Repository"],
      ["session-build-config-base", "Start from branch"],
      ["session-model", "Model"],
      ["session-allowed-tools", "Allowed tools (one per line)"],
      ["session-permission-mode", "Permission mode"],
      ["session-budget", "Budget ($, optional)"],
    ]);
  });
});

describe("yesNoChoices", () => {
  const config = {
    variables: [
      { name: "ticket", kind: "text" as const },
      { name: "deep", kind: "yesno" as const, default: true },
      { name: "docs", kind: "yesno" as const },
    ],
  };

  it("offers the declared yes/no variables, and no text ones", () => {
    expect(yesNoChoices(config)).toEqual([
      { value: "deep", label: "deep" },
      { value: "docs", label: "docs" },
    ]);
  });

  it("offers nothing when no yes/no variable is declared", () => {
    expect(yesNoChoices({ variables: [{ name: "ticket", kind: "text" }] })).toEqual([]);
  });

  it("turns the Branch variable field into a pick from them", () => {
    const [field] = withChoices(
      [{ control: "text", path: ["variable"], testId: "node-setting-variable", label: "Variable" }],
      "variable",
      yesNoChoices(config),
    );

    expect(field).toMatchObject({
      control: "select",
      testId: "node-setting-variable",
      options: ["deep", "docs"],
    });
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

    expect(after.buildConfig).toEqual({ repo: "/other", base: "main", variables: [] });
    expect(after.frame).toEqual(before.frame);
    expectSession(after);
  });

  it("sets allowed tools from one-per-line text, dropping blank lines", () => {
    const after = applyField(worktreeSession(), ["allowedTools"], "Read\n\nBash\n");

    expect(after.allowedTools).toEqual(["Read", "Bash"]);
    expectSession(after);
  });

  it("sets the budget as a number", () => {
    const after = applyField(worktreeSession(), ["budget"], "2.5");

    expect(after.budget).toBe(2.5);
    expectSession(after);
  });

  it.each(["0", "-1"])("keeps the previous budget when the input is %j", (input) => {
    const before = deepFreeze({ ...worktreeSession(), budget: 3 });

    const after = applyField(before, ["budget"], input);

    expect(after).toEqual(before);
    expectSession(after);
  });

  it("removes the budget key when the input is empty", () => {
    const before = deepFreeze({ ...worktreeSession(), budget: 3 });

    const after = applyField(before, ["budget"], "");

    expect(after).not.toHaveProperty("budget");
    expect(after).toEqual(worktreeSession());
    expectSession(after);
  });

  it("sets the base branch and keeps the declared variables", () => {
    const before = deepFreeze({
      ...worktreeSession(),
      buildConfig: { repo: "/r", variables: [{ name: "deep", kind: "yesno" as const }] },
    });

    const after = applyField(before, ["buildConfig", "base"], "dev");

    expect(after.buildConfig).toEqual({
      repo: "/r",
      base: "dev",
      variables: [{ name: "deep", kind: "yesno" }],
    });
    expectSession(after);
  });
});
