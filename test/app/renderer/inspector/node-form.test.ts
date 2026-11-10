import { describe, expect, it } from "vitest";
import { nodeDefaults } from "../../../../src/app/renderer/canvas/store.js";
import {
  addFlag,
  applyNodeSetting,
  describeNodeFields,
  removeFlag,
  renameFlag,
  setFlag,
} from "../../../../src/app/renderer/inspector/node-form.js";
import {
  describeFields,
  type FieldDescription,
} from "../../../../src/app/renderer/inspector/schema-form.js";
import { NodeType, type Node } from "../../../../src/core/flow/schema.js";
import { registry } from "../../../../src/core/nodes/registry.js";
import { branch, flow, trigger } from "../../../fixtures/flow-builders.js";
import { z } from "zod";

const summary = (field: FieldDescription) => [field.control, field.path.join("."), field.testId];

const nodeOf = (type: NodeType, settings?: Record<string, unknown>): Node =>
  ({
    id: `${type}-1`,
    type,
    label: nodeDefaults[type].label,
    position: { x: 0, y: 0 },
    settings: structuredClone(settings ?? nodeDefaults[type].settings),
  }) as Node;

const applied = (node: Node, path: string[], value: Parameters<typeof applyNodeSetting>[2]) => {
  const result = applyNodeSetting(node, path, value);
  if ("error" in result) throw new Error(`unexpected error: ${result.error}`);
  return result.node;
};

describe("describeNodeFields", () => {
  it.each<[NodeType, string[][]]>([
    [
      "agent",
      [
        ["text", "role", "node-setting-role"],
        ["multiline", "instructions", "node-setting-instructions"],
        ["select", "model", "node-setting-model"],
        ["list", "tools", "node-setting-tools"],
        ["list", "given", "node-setting-given"],
        ["list", "writes", "node-setting-writes"],
      ],
    ],
    [
      "gate",
      [
        ["multiline", "shown", "node-setting-shown"],
        ["toggle", "skippable", "node-setting-skippable"],
      ],
    ],
    [
      "ask",
      [
        ["multiline", "question", "node-setting-question"],
        ["list", "options", "node-setting-options"],
      ],
    ],
    [
      "hardstop",
      [
        ["multiline", "condition", "node-setting-condition"],
        ["multiline", "shown", "node-setting-shown"],
      ],
    ],
    [
      "loop",
      [
        ["multiline", "condition", "node-setting-condition"],
        ["number", "cap", "node-setting-cap"],
        ["select", "onCap", "node-setting-on-cap"],
      ],
    ],
    ["trigger", []],
    [
      "output",
      [
        ["text", "name", "node-setting-name"],
        ["text", "type", "node-setting-type"],
      ],
    ],
    ["fork", []],
    [
      "join",
      [
        ["select", "wait", "node-setting-wait"],
        ["select", "onBranchFail", "node-setting-on-branch-fail"],
      ],
    ],
    ["foreach", [["text", "file", "node-setting-file"]]],
    ["branch", [["select", "variable", "node-setting-variable"]]],
  ])("describes the %s settings", (type, expected) => {
    expect(describeNodeFields(type).map(summary)).toEqual(expected);
  });

  it("covers every node type", () => {
    for (const type of NodeType.options) expect(() => describeNodeFields(type)).not.toThrow();
  });

  it("gives every field a plain-word label, never its raw key", () => {
    for (const type of NodeType.options) {
      for (const field of describeNodeFields(type)) {
        const key = field.path.at(-1) ?? "";
        expect(field.label, `${type}.${key}`).toMatch(/^[A-Z]/);
        expect(field.label, `${type}.${key}`).not.toBe(key);
        expect(field.label, `${type}.${key}`).not.toMatch(/[a-z][A-Z]/);
      }
    }
  });

  it("refuses a field with no label", () => {
    const schema = z.object({ unlabelled: z.string() });

    expect(() =>
      describeFields(schema, { prefix: "node-setting", labels: {}, optionLabels: {} }),
    ).toThrow("No label for unlabelled");
  });

  it("names every choice in plain words", () => {
    const options = (type: NodeType) =>
      describeNodeFields(type).flatMap((field) =>
        field.control === "select" ? [field.optionLabels] : [],
      );

    expect(options("loop")).toEqual([{ ask: "Ask me", fail: "Fail the run" }]);
    expect(options("join")).toEqual([
      { all: "Every branch is done", first: "The first branch is done" },
      { wait: "Wait for me to decide", skip: "Go on without it", stop: "Stop the run" },
    ]);
  });

  it("picks an agent's model from Claude Code's models, or the session's", () => {
    const model = describeNodeFields("agent").find((field) => field.path[0] === "model");
    if (model?.control !== "select") throw new Error("expected a select");

    expect(model.options.slice(0, 4)).toEqual(["", "sonnet", "opus", "haiku"]);
    expect(model.optionLabels[""]).toBe("Same as the session");
  });

  it("hints at the agent's task in its empty instructions", () => {
    expect(
      describeNodeFields("agent").find((field) => field.path[0] === "instructions"),
    ).toMatchObject({ placeholder: "Describe the agent's task." });
  });

  it("picks a Branch variable from the flow's declared yes/no variables, in place of a flag", () => {
    const base = flow([trigger("T"), branch("B", "deep")], []);
    const current = {
      ...base,
      session: {
        ...base.session,
        buildConfig: {
          variables: [
            { name: "ticket", kind: "text" as const },
            { name: "deep", kind: "yesno" as const, default: true },
            { name: "docs", kind: "yesno" as const },
          ],
        },
      },
    };

    const fields = describeNodeFields("branch", current);

    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({
      control: "select",
      path: ["variable"],
      label: "Yes/no variable",
      options: ["deep", "docs"],
    });
  });

  it("offers no variable to pick when none is yes/no", () => {
    const [variable] = describeNodeFields("branch", flow([branch("B", "deep")], []));

    expect(variable).toMatchObject({ control: "select", options: [] });
  });

  it("gives a hard stop no switch to turn it off or unlock it", () => {
    const paths = describeNodeFields("hardstop").map((field) => field.path.join("."));

    expect(paths).not.toContain("enabled");
    expect(paths).not.toContain("locked");
  });
});

describe("applyNodeSetting", () => {
  it.each<[NodeType, string[], Parameters<typeof applyNodeSetting>[2], Record<string, unknown>]>([
    ["agent", ["instructions"], "Line one\nLine two", { instructions: "Line one\nLine two" }],
    ["agent", ["tools"], "Read\nBash", { tools: ["Read", "Bash"] }],
    ["gate", ["shown"], "Check the plan", { shown: "Check the plan", skippable: false }],
    ["gate", ["skippable"], true, { shown: "", skippable: true }],
    ["ask", ["options"], "yes\nno", { question: "", options: ["yes", "no"] }],
    ["hardstop", ["condition"], "tests fail", { condition: "tests fail", locked: true }],
    ["loop", ["cap"], "5", { cap: 5, onCap: "fail" }],
    ["loop", ["onCap"], "ask", { cap: 3, onCap: "ask" }],
    ["output", ["name"], "result", { name: "result", type: "" }],
    ["join", ["wait"], "first", { wait: "first" }],
    ["join", ["onBranchFail"], "skip", { wait: "all", onBranchFail: "skip" }],
    ["foreach", ["file"], "plan/units.txt", { file: "plan/units.txt" }],
    ["branch", ["variable"], "deep", { variable: "deep" }],
  ])("sets %s %s and keeps the settings valid", (type, path, value, expected) => {
    const before = nodeOf(type);

    const after = applied(before, path, value);

    expect(after.settings).toMatchObject(expected);
    expect(registry[type].settings.parse(after.settings)).toEqual(after.settings);
    expect({ ...after, settings: before.settings }).toEqual(before);
    expect(before.settings).toEqual(nodeDefaults[type].settings);
  });

  it.each<[NodeType, string[], string, string]>([
    ["foreach", ["file"], "", "Name the list file"],
    ["foreach", ["file"], "/etc/items.txt", "must be relative to the session folder"],
    ["foreach", ["file"], "../items.txt", "must not contain .."],
    ["loop", ["onCap"], "retry", "Choose what happens at the round limit"],
    ["join", ["wait"], "any", "Choose when to continue"],
    ["join", ["onBranchFail"], "retry", "Choose what happens when a branch fails"],
  ])("refuses an invalid %s %s and says why", (type, path, value, reason) => {
    const result = applyNodeSetting(nodeOf(type), path, value);

    expect(result).toEqual({ error: reason });
  });

  it("keeps the loop cap when the text is not a number", () => {
    expect(applied(nodeOf("loop"), ["cap"], "lots").settings).toEqual(nodeDefaults.loop.settings);
  });

  it.each([["enabled"], ["locked"]])("refuses to change a hard stop's %s", (key) => {
    const result = applyNodeSetting(nodeOf("hardstop"), [key], false);

    expect(result).toEqual({ error: "Hard stop is locked" });
  });
});

describe("trigger flags", () => {
  it("adds a flag, off, with a name not yet taken", () => {
    expect(addFlag({})).toEqual({ flag: false });
    expect(addFlag({ flag: true })).toEqual({ flag: true, "flag-2": false });
  });

  it("switches a flag on and off", () => {
    expect(setFlag({ deep: false, quick: true }, "deep", true)).toEqual({
      deep: true,
      quick: true,
    });
  });

  it("renames a flag in place, keeping its value and order", () => {
    const renamed = renameFlag({ a: true, deep: false, z: true }, "deep", "thorough");

    expect(Object.entries(renamed)).toEqual([
      ["a", true],
      ["thorough", false],
      ["z", true],
    ]);
  });

  it("refuses a blank name or one already taken", () => {
    const flags = { a: true, b: false };

    expect(renameFlag(flags, "a", " ")).toBe(flags);
    expect(renameFlag(flags, "a", "b")).toBe(flags);
  });

  it("trims a new name", () => {
    expect(renameFlag({ a: true }, "a", " deep ")).toEqual({ deep: true });
  });

  it("removes a flag", () => {
    expect(removeFlag({ a: true, b: false }, "a")).toEqual({ b: false });
  });
});
