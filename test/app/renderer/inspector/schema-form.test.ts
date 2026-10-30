import { describe, expect, it } from "vitest";
import {
  applyField,
  describeFields,
  sessionSettingsSchema,
  type FieldDescription,
} from "../../../../src/app/renderer/inspector/schema-form.js";
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
    workingFolder: { kind: "worktree", branch: "main", repo: "/r" },
    model: "sonnet",
    allowedTools: ["Read"],
    permissionMode: "default",
    connectors: [],
    frame: { nodes: ["A", "B"] },
  });

const pathSession = (): Session =>
  deepFreeze({ ...worktreeSession(), workingFolder: { kind: "path", path: "/work" } });

const kindField = () => {
  const [field] = describeFields(sessionSettingsSchema);
  if (field?.control !== "select") throw new Error("expected the working folder kind select");
  return field;
};

describe("describeFields", () => {
  it("describes working folder kind, model, allowed tools and budget in schema order", () => {
    expect(describeFields(sessionSettingsSchema).map(summary)).toEqual([
      {
        control: "select",
        path: ["workingFolder", "kind"],
        testId: "session-working-folder-kind",
        options: ["path", "worktree"],
      },
      { control: "text", path: ["model"], testId: "session-model" },
      { control: "list", path: ["allowedTools"], testId: "session-allowed-tools" },
      { control: "number", path: ["budget"], testId: "session-budget" },
    ]);
  });

  it("describes the path variant's folder as a text field", () => {
    expect(kindField().variants.path?.map(summary)).toEqual([
      {
        control: "text",
        path: ["workingFolder", "path"],
        testId: "session-working-folder-path",
      },
    ]);
  });

  it("describes the worktree variant's repo and base branch as text fields", () => {
    const fields = kindField().variants.worktree?.map(summary);

    expect(fields).toHaveLength(2);
    expect(fields).toEqual(
      expect.arrayContaining([
        {
          control: "text",
          path: ["workingFolder", "repo"],
          testId: "session-working-folder-repo",
        },
        {
          control: "text",
          path: ["workingFolder", "branch"],
          testId: "session-working-folder-branch",
        },
      ]),
    );
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

    const after = applyField(before, ["workingFolder", "repo"], "/other");

    expect(after.workingFolder).toEqual({ kind: "worktree", branch: "main", repo: "/other" });
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

  it("switches worktree to path with an empty path and no worktree keys", () => {
    const before = worktreeSession();

    const after = applyField(before, ["workingFolder", "kind"], "path");

    expect(after.workingFolder).toStrictEqual({ kind: "path", path: "" });
    expect(after.name).toBe("build");
    expect(after.frame).toEqual({ nodes: ["A", "B"] });
    expectSession(after);
  });

  it("switches path to worktree with an empty branch and no repo key", () => {
    const after = applyField(pathSession(), ["workingFolder", "kind"], "worktree");

    expect(after.workingFolder).toStrictEqual({ kind: "worktree", branch: "" });
    expect(after.name).toBe("build");
    expect(after.frame).toEqual({ nodes: ["A", "B"] });
    expectSession(after);
  });
});
