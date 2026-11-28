import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  assignField,
  containerFields,
  describeFields,
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

describe("generic fields", () => {
  const schema = z.object({
    done: z.boolean(),
    names: z.array(z.string()),
    sizes: z.array(z.number()),
  });
  const form = {
    prefix: "node-setting",
    labels: { done: "Done", names: "Names", sizes: "Sizes" },
    optionLabels: {},
  };

  it("describes a boolean as a toggle and a list of strings or numbers as a list", () => {
    expect(describeFields(schema, form)).toEqual([
      { control: "toggle", path: ["done"], testId: "node-setting-done", label: "Done" },
      { control: "list", path: ["names"], testId: "node-setting-names", label: "Names" },
      { control: "list", path: ["sizes"], testId: "node-setting-sizes", label: "Sizes" },
    ]);
  });

  it("stores a toggle's value as it is", () => {
    expect(assignField(schema, { done: false, names: [], sizes: [] }, ["done"], true)).toEqual({
      done: true,
      names: [],
      sizes: [],
    });
  });

  it.each([
    ["names", " plan.md \n\n  code.md\n", ["plan.md", "code.md"]],
    ["sizes", "1\n  20 \n\n3", [1, 20, 3]],
  ])("splits a %s list into trimmed, non-empty lines", (key, text, stored) => {
    const current = { done: false, names: [], sizes: [] };

    expect(assignField(schema, current, [key], text)).toEqual({ ...current, [key]: stored });
  });
});

describe("rows of objects", () => {
  const schema = z.object({
    items: z.array(z.object({ name: z.string(), note: z.string() })).optional(),
  });
  const form = {
    prefix: "node-setting",
    labels: { items: "Items", "items.name": "Name", "items.note": "Note" },
    optionLabels: {},
    addLabels: { items: "+ Item" },
  };

  it("describes a list of objects as rows, one per stored item, each with its own fields and ids", () => {
    const values = {
      items: [
        { name: "a", note: "" },
        { name: "b", note: "" },
      ],
    };

    expect(describeFields(schema, form, values)).toEqual([
      {
        control: "rows",
        path: ["items"],
        testId: "node-setting-items",
        label: "Items",
        addLabel: "+ Item",
        addTestId: "node-setting-items-add",
        rows: [0, 1].map((index) => ({
          removeTestId: `node-setting-items-${index}-remove`,
          fields: [
            {
              control: "text",
              path: ["items", String(index), "name"],
              testId: `node-setting-items-${index}-name`,
              label: "Name",
            },
            {
              control: "text",
              path: ["items", String(index), "note"],
              testId: `node-setting-items-${index}-note`,
              label: "Note",
            },
          ],
        })),
      },
    ]);
  });

  it("describes no rows when nothing is stored", () => {
    expect(describeFields(schema, form)).toMatchObject([{ control: "rows", rows: [] }]);
  });

  it("appends an empty row, starting the list when there is none", () => {
    expect(assignField(schema, {}, ["items"], { row: "add" })).toEqual({
      items: [{ name: "", note: "" }],
    });
  });

  it("sets one field of one row", () => {
    const current = {
      items: [
        { name: "a", note: "" },
        { name: "b", note: "" },
      ],
    };

    expect(assignField(schema, current, ["items", "1", "note"], "later")).toEqual({
      items: [
        { name: "a", note: "" },
        { name: "b", note: "later" },
      ],
    });
  });

  it("removes one row and keeps the rest in order", () => {
    const current = {
      items: [
        { name: "a", note: "" },
        { name: "b", note: "" },
        { name: "c", note: "" },
      ],
    };

    expect(assignField(schema, current, ["items", "1"], { row: "remove" })).toEqual({
      items: [
        { name: "a", note: "" },
        { name: "c", note: "" },
      ],
    });
  });
});

describe("a combo field", () => {
  const schema = z.object({ name: z.string(), picked: z.boolean().optional() });
  const form = {
    prefix: "node-setting",
    labels: { name: "Name" },
    optionLabels: {},
    hidden: new Set(["picked"]),
    combos: { name: "picked" },
  };

  it("describes a string named as a combo as free text with a pick list beside it", () => {
    expect(describeFields(schema, form)).toEqual([
      {
        control: "combo",
        path: ["name"],
        testId: "node-setting-name",
        existingTestId: "node-setting-name-existing",
        label: "Name",
        options: [],
      },
    ]);
  });
});
