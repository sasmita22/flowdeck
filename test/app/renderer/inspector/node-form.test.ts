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
import type { LibraryLookup } from "../../../../src/core/flow/libraries.js";
import { NodeType, type Node } from "../../../../src/core/flow/schema.js";
import { blueprintVariables } from "../../../../src/core/flow/variables.js";
import { registry } from "../../../../src/core/nodes/registry.js";
import {
  agentProducesAddTestId,
  branchVariableExistingTestId,
  produceRowTestIds,
} from "../../../../src/app/renderer/test-ids.js";
import { agent, branch, onMainFlow, thenWire } from "../../../fixtures/flow-builders.js";
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
        ["rows", "produces", "node-setting-produces"],
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
    ["branch", [["combo", "variable", "node-setting-variable"]]],
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

  describe("a Branch's Variable name", () => {
    const blueprint = onMainFlow(
      [branch("first", "approved"), branch("second", "docs"), branch("third", "approved")],
      [thenWire("first", "second"), thenWire("second", "third")],
    );

    it("is the only field: a name typed freely, with the other Branch variables to pick from", () => {
      const fields = describeNodeFields(
        "branch",
        blueprint,
        { variable: "docs" },
        {
          nodeId: "second",
        },
      );

      expect(fields).toEqual([
        {
          control: "combo",
          path: ["variable"],
          testId: "node-setting-variable",
          existingTestId: branchVariableExistingTestId,
          label: "Variable name",
          options: ["approved"],
        },
      ]);
    });

    it("offers a name this Branch shares with another Branch, once", () => {
      const [variable] = describeNodeFields(
        "branch",
        blueprint,
        { variable: "approved" },
        {
          nodeId: "first",
        },
      );

      expect(variable).toMatchObject({ options: ["docs", "approved"] });
    });

    it("offers nothing on a blueprint with no other Branch", () => {
      const lone = onMainFlow([branch("only", "approved")], []);

      const [variable] = describeNodeFields(
        "branch",
        lone,
        { variable: "approved" },
        {
          nodeId: "only",
        },
      );

      expect(variable).toMatchObject({ options: [] });
    });
  });

  describe("an Agent's produce rows", () => {
    const sendsUp: LibraryLookup = (flowId) =>
      flowId === "asks"
        ? { name: "asks", kind: "node-library", sessions: [], uses: [], sends: ["up"] }
        : undefined;
    const library = {
      id: "lib",
      label: "lib",
      position: { x: 0, y: 0 },
      type: "library",
      settings: { libraryId: "asks", label: "lib", overrides: {} },
    };
    const blueprint = onMainFlow(
      [agent("check"), branch("decide", "approved"), branch("docs", "docs"), library],
      [thenWire("check", "decide"), thenWire("decide", "docs"), thenWire("docs", "lib")],
    );
    const rows = {
      produces: [
        { variable: "approved", yesIf: "tests pass", noIf: "tests fail" },
        { variable: "", yesIf: "", noIf: "" },
      ],
    };
    const producesField = (settings: Record<string, unknown>) => {
      const field = describeNodeFields("agent", blueprint, settings, {
        nodeId: "check",
        libraries: sendsUp,
      }).find(({ path }) => path[0] === "produces");
      if (field?.control !== "rows") throw new Error("expected produce rows");
      return field;
    };

    it("shows one row per produced variable, with an add button and a remove button per row", () => {
      const field = producesField(rows);

      expect(field.label).toBe("Variables it produces");
      expect(field.addLabel).toBe("+ Produce variable");
      expect(field.addTestId).toBe(agentProducesAddTestId);
      expect(field.rows.map(({ removeTestId }) => removeTestId)).toEqual([
        produceRowTestIds.remove(0),
        produceRowTestIds.remove(1),
      ]);
      expect(field.rows.map(({ fields }) => fields.map(summary))).toEqual([
        [
          ["select", "produces.0.variable", produceRowTestIds.variable(0)],
          ["text", "produces.0.yesIf", produceRowTestIds.yesIf(0)],
          ["text", "produces.0.noIf", produceRowTestIds.noIf(0)],
        ],
        [
          ["select", "produces.1.variable", produceRowTestIds.variable(1)],
          ["text", "produces.1.yesIf", produceRowTestIds.yesIf(1)],
          ["text", "produces.1.noIf", produceRowTestIds.noIf(1)],
        ],
      ]);
    });

    it("names the row ids from the row index and field", () => {
      expect([
        produceRowTestIds.variable(0),
        produceRowTestIds.yesIf(0),
        produceRowTestIds.noIf(2),
        produceRowTestIds.remove(1),
        agentProducesAddTestId,
      ]).toEqual([
        "node-setting-produces-0-variable",
        "node-setting-produces-0-yes-if",
        "node-setting-produces-2-no-if",
        "node-setting-produces-1-remove",
        "node-setting-produces-add",
      ]);
    });

    it("labels each row's fields in plain words", () => {
      const [first] = producesField(rows).rows;

      expect(first?.fields.map(({ label }) => label)).toEqual(["Variable name", "Yes if", "No if"]);
    });

    it("offers exactly the blueprint's own variables in each row: its Branch variables and what its libraries send up", () => {
      const [first] = producesField(rows).rows;
      const owned = blueprintVariables(blueprint, sendsUp).owned.map(({ name }) => name);

      expect(first?.fields[0]).toMatchObject({ options: owned });
      expect(owned).toEqual(["approved", "docs", "up"]);
    });

    it("shows no rows for an Agent that produces nothing, or was saved before rows existed", () => {
      expect(producesField({ produces: [] }).rows).toEqual([]);
      expect(producesField({}).rows).toEqual([]);
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
    ["branch", ["variable"], { pick: "deep" }, { variable: "deep", shared: true }],
    ["agent", ["produces"], { row: "add" }, { produces: [{ variable: "", yesIf: "", noIf: "" }] }],
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

  it("marks a Branch variable picked from the other Branches as shared, and a typed one as not", () => {
    const picked = applied(nodeOf("branch"), ["variable"], { pick: "approved" });
    const typed = applied(picked, ["variable"], "approved");

    expect(picked.settings).toEqual({ variable: "approved", shared: true });
    expect(typed.settings).toEqual({ variable: "approved" });
  });

  it("refuses to set a Branch's shared mark directly", () => {
    expect(applyNodeSetting(nodeOf("branch"), ["shared"], true)).toEqual({
      error: "This setting is locked",
    });
  });

  it("adds produce rows one after another, each empty", () => {
    const once = applied(nodeOf("agent"), ["produces"], { row: "add" });
    const twice = applied(once, ["produces"], { row: "add" });

    expect(twice.settings).toMatchObject({
      produces: [
        { variable: "", yesIf: "", noIf: "" },
        { variable: "", yesIf: "", noIf: "" },
      ],
    });
  });

  it("adds a produce row to an Agent saved before rows existed", () => {
    const old = nodeOf("agent", { role: "", instructions: "Go.", model: "sonnet" });

    expect(applied(old, ["produces"], { row: "add" }).settings).toEqual({
      role: "",
      instructions: "Go.",
      model: "sonnet",
      produces: [{ variable: "", yesIf: "", noIf: "" }],
    });
  });

  it("fills one field of one produce row and leaves the others", () => {
    const two = nodeOf("agent", {
      ...nodeDefaults.agent.settings,
      produces: [
        { variable: "approved", yesIf: "", noIf: "" },
        { variable: "docs", yesIf: "", noIf: "" },
      ],
    });

    const yes = applied(two, ["produces", "1", "yesIf"], "docs changed");
    const renamed = applied(yes, ["produces", "0", "variable"], "ship");

    expect(renamed.settings).toMatchObject({
      produces: [
        { variable: "ship", yesIf: "", noIf: "" },
        { variable: "docs", yesIf: "docs changed", noIf: "" },
      ],
    });
  });

  it("removes row 0 of two and keeps only the other in the settings", () => {
    const two = nodeOf("agent", {
      ...nodeDefaults.agent.settings,
      produces: [
        { variable: "approved", yesIf: "a", noIf: "b" },
        { variable: "docs", yesIf: "c", noIf: "d" },
      ],
    });

    expect(applied(two, ["produces", "0"], { row: "remove" }).settings).toMatchObject({
      produces: [{ variable: "docs", yesIf: "c", noIf: "d" }],
    });
  });

  it("refuses done as a produced variable, the name a Loop's verdict uses", () => {
    const row = applied(nodeOf("agent"), ["produces"], { row: "add" });

    expect(applyNodeSetting(row, ["produces", "0", "variable"], "done")).toEqual({
      error: expect.stringContaining("done") as string,
    });
  });

  it("never offers a given-files or written-file field", () => {
    const paths = describeNodeFields("agent").map((field) => field.path.join("."));

    expect(paths).not.toContain("given");
    expect(paths).not.toContain("writes");
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
