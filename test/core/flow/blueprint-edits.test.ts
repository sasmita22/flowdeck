import { z } from "zod";
import { describe, expect, it } from "vitest";
import { checkEdit, newProblems } from "../../../src/core/flow/blueprint-edits.js";
import { defaultSettings as agentDefaults } from "../../../src/core/nodes/agent/defaults.js";
import {
  agent,
  branch,
  fileWire,
  flow,
  fork,
  join,
  output,
  prompt,
  script,
  thenWire,
  trigger,
  wire,
} from "../../fixtures/flow-builders.js";

const zodMessage = (schema: z.ZodType, value: unknown) => {
  const issue = schema.safeParse(value).error?.issues[0];
  if (issue === undefined) expect.fail("the schema accepted the value");
  return issue.message;
};

const expectedString = zodMessage(z.string(), 7);
const expectedArray = zodMessage(z.array(z.string()), "Read");

const blueprint = () =>
  flow([trigger("start"), agent("a1"), prompt("p1")], [thenWire("start", "a1")]);

const refused = (name: string, input: unknown) => {
  const before = blueprint();
  const untouched = structuredClone(before);
  const result = checkEdit(before, name, input);

  expect(before).toEqual(untouched);
  expect(result).toEqual({ ok: false, reason: expect.stringMatching(/\S/) });
  return (result as { reason: string }).reason;
};

describe("checkEdit refuses", () => {
  it("input that fails its tool schema, with the zod issue as the reason", () => {
    expect(refused("delete_node", { nodeId: 7 })).toContain(expectedString);
  });

  it("an unknown node type", () => {
    refused("add_node", { type: "teleport", label: "Beam", settings: {} });
  });

  it("add_node settings that fail the type's settings schema", () => {
    expect(
      refused("add_node", { type: "agent", label: "Planner", settings: { tools: "Read" } }),
    ).toContain(expectedArray);
  });

  it("change_node settings that fail the node type's settings schema", () => {
    expect(refused("change_node", { nodeId: "a1", settings: { model: 7 } })).toContain(
      expectedString,
    );
  });

  it.each([
    ["change_node", { nodeId: "ghost", label: "Boo" }],
    ["delete_node", { nodeId: "ghost" }],
    [
      "wire",
      { kind: "then", from: { node: "a1", port: "out" }, to: { node: "ghost", port: "in" } },
    ],
  ])("%s naming a node that is not in the blueprint", (name, input) => {
    expect(refused(name, input)).toContain("ghost");
  });

  it("an edit that still names a blueprint", () => {
    expect(refused("delete_node", { nodeId: "p1", blueprint: "flow-1" })).toContain("blueprint");
  });

  it("a wire from a port the node type does not have", () => {
    const input = {
      kind: "then",
      from: { node: "a1", port: "sideways" },
      to: { node: "p1", port: "in" },
    };

    expect(refused("wire", input)).toContain("sideways");
  });

  it("a wire whose kind does not match its ports", () => {
    refused("wire", {
      kind: "file",
      file: "plan.md",
      from: { node: "a1", port: "out" },
      to: { node: "p1", port: "file-in" },
    });
  });
});

describe("checkEdit accepts", () => {
  it("add_node, merging the given settings over the type's defaults", () => {
    const result = checkEdit(blueprint(), "add_node", {
      type: "agent",
      label: "Planner",
      settings: { instructions: "Plan the work." },
    });

    expect(result).toEqual({
      ok: true,
      edit: expect.objectContaining({
        type: "agent",
        label: "Planner",
        settings: { ...agentDefaults, instructions: "Plan the work." },
      }),
    });
  });

  it.each([
    ["change_node", { nodeId: "a1", label: "Builder", settings: { model: "haiku" } }],
    ["delete_node", { nodeId: "p1" }],
    ["wire", wire("a1", "out", "p1", "in")],
    ["wire", fileWire("a1", "p1", "plan.md")],
    ["set_variable", { name: "ticket", kind: "text", default: "FD-1" }],
  ])("a well-formed %s", (name, input) => {
    expect(checkEdit(blueprint(), name, input)).toMatchObject({ ok: true });
  });
});

describe("newProblems", () => {
  const parallelNodes = [trigger("start"), fork("split"), agent("a1"), agent("a2"), join("merge")];
  const parallelWires = [
    thenWire("start", "split"),
    wire("split", "out", "a1", "in"),
    wire("split", "out", "a2", "in"),
    thenWire("a1", "merge"),
    thenWire("a2", "merge"),
  ];
  const strayBranch = (before: ReturnType<typeof flow>) =>
    flow([...before.nodes, agent("a3")], [...before.wires, wire("split", "out", "a3", "in")]);

  it("reports the problem an edit leaves when an agent branch is not wired onward", () => {
    const before = flow(parallelNodes, parallelWires);

    expect(newProblems(before, strayBranch(before))).toEqual([
      expect.objectContaining({ rule: "parallel-section", node: "split" }),
    ]);
  });

  it("does not repeat problems the blueprint already had", () => {
    const blankAgent = agent("a1", { settings: { instructions: "" } });
    const before = flow(
      [parallelNodes[0], parallelNodes[1], blankAgent, ...parallelNodes.slice(3)],
      parallelWires,
    );

    expect(newProblems(before, strayBranch(before))).toEqual([
      expect.objectContaining({ rule: "parallel-section", node: "split" }),
    ]);
  });

  it("reports nothing for an edit that adds no problem", () => {
    const before = flow(parallelNodes, parallelWires);
    const after = flow(
      before.nodes.map((node) => (node.id === "a1" ? { ...node, label: "Renamed" } : node)),
      before.wires,
    );

    expect(newProblems(before, after)).toEqual([]);
  });

  it("does not report a problem whose only change is its message", () => {
    const nodes = [fork("split"), agent("a1"), agent("a2"), join("merge")];
    const before = flow(nodes, []);
    const after = flow(nodes, [wire("split", "out", "a1", "in")]);

    expect(newProblems(before, after)).toEqual([]);
  });

  describe("reads only the main flow", () => {
    const blankAgent = agent("blank", { settings: { instructions: "" } });
    const before = flow(
      [trigger("start"), prompt("a"), output("stop")],
      [thenWire("start", "a"), thenWire("a", "stop")],
    );

    it("reports nothing for a blank Agent added off the main flow", () => {
      const after = flow([...before.nodes, blankAgent], before.wires);

      expect(newProblems(before, after)).toEqual([]);
    });

    it("reports the blank Agent's settings once it is added on the main flow", () => {
      const after = flow(
        [...before.nodes, blankAgent],
        [thenWire("start", "a"), thenWire("a", "blank"), thenWire("blank", "stop")],
      );

      expect(newProblems(before, after)).toEqual([
        expect.objectContaining({ rule: "required-settings", node: "blank" }),
      ]);
    });

    it.each([
      ["a Script with no command", script("loose", { settings: { command: "" } }), "out"],
      ["a Branch with no variable picked", branch("loose", ""), "yes"],
    ])(
      "reports nothing when a wire brings %s already on the canvas onto it",
      (_name, loose, out) => {
        const nodes = [trigger("start"), output("stop"), loose];
        const looseBefore = flow(nodes, [thenWire("start", "stop")]);
        const wiredIn = flow(nodes, [thenWire("start", "loose"), wire("loose", out, "stop", "in")]);

        expect(newProblems(looseBefore, wiredIn)).toEqual([]);
      },
    );

    it("reports nothing when Start is wired to an unfilled Script while Stop is still loose", () => {
      const nodes = [
        trigger("start"),
        script("loose", { settings: { command: "" } }),
        output("stop"),
      ];

      expect(newProblems(flow(nodes, []), flow(nodes, [thenWire("start", "loose")]))).toEqual([]);
    });

    it("reports a cycle drawn off the main flow once a wire brings it onto it", () => {
      const nodes = [trigger("start"), output("stop"), agent("a"), agent("b")];
      const mainFlow = [thenWire("start", "stop"), thenWire("a", "b")];
      const looseCycle = flow(nodes, [...mainFlow, thenWire("b", "a")]);
      const wiredIn = flow(nodes, [...looseCycle.wires, thenWire("start", "a")]);

      expect(newProblems(flow(nodes, mainFlow), looseCycle)).toEqual([]);
      expect(newProblems(looseCycle, wiredIn)).toEqual(
        expect.arrayContaining([expect.objectContaining({ rule: "no-cycle" })]),
      );
    });
  });

  describe("tells wires apart by their ends", () => {
    const nodes = [
      trigger("start"),
      agent("a1"),
      agent("a2"),
      prompt("p1"),
      branch("b1", "go"),
      output("stop"),
    ];
    const mainFlowWires = [
      thenWire("start", "a1"),
      thenWire("start", "a2"),
      thenWire("start", "b1"),
      thenWire("p1", "stop"),
    ];
    const onFlow = (wires: unknown[]) => flow(nodes, [...wires, ...mainFlowWires]);
    const badPort = (from: string, port = "out") => wire(from, port, "p1", "bogus");
    const portProblem = (index: number) =>
      expect.objectContaining({ rule: "ports", node: "p1", wire: index });

    it("reports a problem on another wire between the same nodes, from a different port", () => {
      const before = onFlow([badPort("b1", "yes")]);
      const after = onFlow([badPort("b1", "yes"), badPort("b1", "no")]);

      expect(newProblems(before, after)).toEqual([portProblem(1)]);
    });

    it("reports a problem on a new wire that repeats an existing wire's message", () => {
      const before = onFlow([badPort("a1")]);
      const after = onFlow([badPort("a1"), badPort("a2")]);

      expect(newProblems(before, after)).toEqual([portProblem(1)]);
    });

    it("reports only the new wire's problem after an earlier wire is deleted", () => {
      const before = onFlow([thenWire("start", "a1"), badPort("a1")]);
      const after = onFlow([badPort("a1"), badPort("a2")]);

      expect(newProblems(before, after)).toEqual([portProblem(1)]);
    });
  });
});
