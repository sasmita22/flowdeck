import { describe, expect, it } from "vitest";
import { nodeDefaults } from "../../../../src/app/renderer/canvas/store.js";
import * as nodeForm from "../../../../src/app/renderer/inspector/node-form.js";
import {
  applyNodeSetting,
  describeNodeFields,
} from "../../../../src/app/renderer/inspector/node-form.js";
import {
  describeFields,
  type FieldDescription,
} from "../../../../src/app/renderer/inspector/schema-form.js";
import { NodeType, type Node } from "../../../../src/core/flow/schema.js";
import { registry } from "../../../../src/core/nodes/registry.js";
import { agent, branch, flow, trigger } from "../../../fixtures/flow-builders.js";
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
        ["list", "given", "node-setting-given"],
        ["list", "writes", "node-setting-writes"],
        ["text", "produces", "node-setting-produces"],
      ],
    ],
    [
      "gate",
      [
        ["select", "stopWhen", "node-setting-stop-when"],
        ["multiline", "instruction", "node-setting-instruction"],
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
    ["library", []],
    [
      "branch",
      [
        ["select", "decidedBy", "node-setting-decided-by"],
        ["text", "variable", "node-setting-variable"],
      ],
    ],
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

  it("lists no tools field for an Agent", () => {
    const paths = describeNodeFields("agent").map((field) => field.path.join("."));

    expect(paths).not.toContain("tools");
  });

  it("takes a Branch variable as a typed name, with nothing to pick from", () => {
    const [, variable] = describeNodeFields("branch", flow([trigger("T"), branch("B", "")], []));

    expect(variable).toEqual({
      control: "text",
      path: ["variable"],
      testId: "node-setting-variable",
      label: "Yes/no variable",
    });
  });

  describe("a Branch's Decided by", () => {
    const producer = (id: string, produces?: string) =>
      agent(id, produces === undefined ? {} : { settings: { produces } });
    const producers = flow(
      [
        trigger("T"),
        producer("check", "tests-passed"),
        producer("plain"),
        producer("review", "approved"),
        producer("again", "tests-passed"),
        branch("B", ""),
      ],
      [],
    );

    it("offers a build variable, the default, or a value an earlier Agent produces", () => {
      const [decidedBy] = describeNodeFields("branch", producers);

      expect(decidedBy).toMatchObject({
        control: "select",
        path: ["decidedBy"],
        testId: "node-setting-decided-by",
        label: "Decided by",
        options: ["variable", "value"],
        optionLabels: {
          variable: "A build variable",
          value: "A value an earlier Agent produces",
        },
      });
    });

    it("shows a build variable as picked when a Branch has no Decided by", () => {
      const [decidedBy] = describeNodeFields("branch", producers, { variable: "deep" });

      expect(decidedBy).toMatchObject({ fallback: "variable" });
    });

    it.each<[string, Record<string, unknown>]>([
      ["with no Decided by, as old blueprints have", { variable: "deep" }],
      ["decided by a build variable", { decidedBy: "variable", variable: "deep" }],
    ])("shows the variable name field for a Branch %s", (_, settings) => {
      expect(describeNodeFields("branch", producers, settings).map(summary)).toEqual([
        ["select", "decidedBy", "node-setting-decided-by"],
        ["text", "variable", "node-setting-variable"],
      ]);
    });

    it("shows a value picker listing each value the flow's Agents produce, once, in place of the variable", () => {
      const fields = describeNodeFields("branch", producers, {
        variable: "",
        decidedBy: "value",
        value: "tests-passed",
      });

      expect(fields.map(summary)).toEqual([
        ["select", "decidedBy", "node-setting-decided-by"],
        ["select", "value", "node-setting-value"],
      ]);
      expect(fields[1]).toMatchObject({ options: ["tests-passed", "approved"] });
    });
  });

  describe("a Gate's Condition to stop", () => {
    it("offers Always and Conditional, labelled in plain words", () => {
      const [stopWhen] = describeNodeFields("gate");

      expect(stopWhen).toMatchObject({
        control: "select",
        path: ["stopWhen"],
        testId: "node-setting-stop-when",
        label: "Condition to stop",
        options: ["always", "conditional"],
        optionLabels: { always: "Always", conditional: "Conditional" },
      });
    });

    it("shows Condition to stop and Instruction for an Always Gate, with no condition, Shown or Skippable field", () => {
      const paths = describeNodeFields("gate", undefined, nodeDefaults.gate.settings).map((field) =>
        field.path.join("."),
      );

      expect(paths).toEqual(["stopWhen", "instruction"]);
      expect(paths).not.toContain("condition");
      expect(paths).not.toContain("shown");
      expect(paths).not.toContain("skippable");
    });

    it("shows the condition field between them for a Conditional Gate", () => {
      expect(
        describeNodeFields("gate", undefined, {
          stopWhen: "conditional",
          condition: "",
          instruction: "",
        }).map(summary),
      ).toEqual([
        ["select", "stopWhen", "node-setting-stop-when"],
        ["multiline", "condition", "node-setting-condition"],
        ["multiline", "instruction", "node-setting-instruction"],
      ]);
    });
  });
});

describe("applyNodeSetting", () => {
  it.each<[NodeType, string[], Parameters<typeof applyNodeSetting>[2], Record<string, unknown>]>([
    ["agent", ["instructions"], "Line one\nLine two", { instructions: "Line one\nLine two" }],
    [
      "gate",
      ["instruction"],
      "Check the plan",
      { stopWhen: "always", condition: "", instruction: "Check the plan" },
    ],
    [
      "gate",
      ["stopWhen"],
      "conditional",
      { stopWhen: "conditional", condition: "", instruction: "" },
    ],
    ["gate", ["condition"], "tests fail", { condition: "tests fail" }],
    ["loop", ["cap"], "5", { cap: 5, onCap: "fail" }],
    ["loop", ["onCap"], "ask", { cap: 3, onCap: "ask" }],
    ["output", ["name"], "result", { name: "result", type: "" }],
    ["join", ["wait"], "first", { wait: "first" }],
    ["join", ["onBranchFail"], "skip", { wait: "all", onBranchFail: "skip" }],
    ["branch", ["variable"], "deep", { variable: "deep" }],
    ["branch", ["decidedBy"], "value", { decidedBy: "value" }],
    ["agent", ["produces"], "tests-passed", { produces: "tests-passed" }],
  ])("sets %s %s and keeps the settings valid", (type, path, value, expected) => {
    const before = nodeOf(type);

    const after = applied(before, path, value);

    expect(after.settings).toMatchObject(expected);
    expect(registry[type].settings.parse(after.settings)).toEqual(after.settings);
    expect({ ...after, settings: before.settings }).toEqual(before);
    expect(before.settings).toEqual(nodeDefaults[type].settings);
  });

  it.each<[NodeType, string[], string, string]>([
    ["loop", ["onCap"], "retry", "Choose what happens at the round limit"],
    ["join", ["wait"], "any", "Choose when to continue"],
    ["join", ["onBranchFail"], "retry", "Choose what happens when a branch fails"],
  ])("refuses an invalid %s %s and says why", (type, path, value, reason) => {
    const result = applyNodeSetting(nodeOf(type), path, value);

    expect(result).toEqual({ error: reason });
  });

  it("picks the value a value-decided Branch reads", () => {
    const valueMode = applied(nodeOf("branch"), ["decidedBy"], "value");

    expect(applied(valueMode, ["value"], "tests-passed").settings).toMatchObject({
      decidedBy: "value",
      value: "tests-passed",
    });
  });

  it("refuses done as a produced value, the name a Loop's verdict uses", () => {
    expect(applyNodeSetting(nodeOf("agent"), ["produces"], "done")).toEqual({
      error: expect.stringContaining("done") as string,
    });
  });

  it("keeps the loop cap when the text is not a number", () => {
    expect(applied(nodeOf("loop"), ["cap"], "lots").settings).toEqual(nodeDefaults.loop.settings);
  });

  it.each([["libraryId"], ["label"], ["overrides"]])(
    "refuses to change a library node's hidden %s",
    (key) => {
      const result = applyNodeSetting(nodeOf("library"), [key], "x");

      expect(result).toEqual({ error: "This setting is locked" });
    },
  );
});

describe("the Branch no-variables hint", () => {
  it("is gone, since any typed name is a variable", () => {
    expect(Object.keys(nodeForm)).not.toContain("missingYesNoVariable");
  });
});
