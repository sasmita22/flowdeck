import { z } from "zod";
import { describe, expect, it } from "vitest";
import {
  checkEdit,
  connectionRefusal,
  editProblems,
  newProblems,
  nextConnectionId,
} from "../../../src/core/flow/blueprint-edits.js";
import { libraryLabelFor, type LibraryLookup } from "../../../src/core/flow/libraries.js";
import { WireKind, type Flow } from "../../../src/core/flow/schema.js";
import { defaultSettings as agentDefaults } from "../../../src/core/nodes/agent/defaults.js";
import {
  agent,
  branch,
  flow,
  fork,
  join,
  output,
  thenWire,
  trigger,
  wire,
  workspaceContainer,
  sessionContainer,
  flowSettings,
} from "../../fixtures/flow-builders.js";

const zodMessage = (schema: z.ZodType, value: unknown) => {
  const issue = schema.safeParse(value).error?.issues[0];
  if (issue === undefined) expect.fail("the schema accepted the value");
  return issue.message;
};

const expectedString = zodMessage(z.string(), 7);
const expectedArray = zodMessage(z.array(z.string()), "Read");

const blueprint = () =>
  flow([trigger("start"), agent("a1"), agent("p1")], [thenWire("start", "a1")]);

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

  it.each(["prompt", "script"])("a %s node, a type the blueprint no longer has", (type) => {
    refused("add_node", { type, label: "Old", settings: {} });
  });

  it("a variable declaration, which no edit applies", () => {
    expect(refused("set_variable", { name: "ticket", kind: "text" })).toContain("set_variable");
  });

  it("add_node settings that fail the type's settings schema", () => {
    expect(
      refused("add_node", { type: "agent", label: "Planner", settings: { produces: "approved" } }),
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
    expect(refused("wire", { ...wire("a1", "out", "p1", "in"), kind: "event" })).toContain(
      "not Event wires",
    );
  });

  it("a File wire, as a kind the wire tool does not take", () => {
    const reason = refused("wire", {
      kind: "file",
      file: "plan.md",
      from: { node: "a1", port: "file-out" },
      to: { node: "p1", port: "file-in" },
    });

    expect(reason).toContain(zodMessage(WireKind, "file"));
    expect(reason).not.toMatch(/file wire/i);
  });
});

describe("checkEdit on a wire across containers", () => {
  const twoSessions = () =>
    flow([agent("a"), agent("a2"), agent("b"), agent("c")], [], flowSettings, {
      containers: [
        sessionContainer(["a", "a2"]),
        sessionContainer(["b"], { id: "session-2", name: "review" }),
      ],
    });

  it.each([
    ["a member of one session to a member of another", "a", "b"],
    ["a canvas-level node to a session member", "c", "a"],
  ])("refuses a wire from %s", (_, from, to) => {
    const before = twoSessions();
    const untouched = structuredClone(before);

    expect(checkEdit(before, "wire", wire(from, "out", to, "in"))).toEqual({
      ok: false,
      reason: expect.stringContaining("crosses a container's edge"),
    });
    expect(before).toEqual(untouched);
  });

  it("accepts a wire between two members of one session", () => {
    expect(checkEdit(twoSessions(), "wire", wire("a", "out", "a2", "in"))).toMatchObject({
      ok: true,
    });
  });
});

describe("checkEdit on a library node", () => {
  const withLibrary = (overrides: Record<string, { model?: string; repo?: string }> = {}) =>
    flow(
      [
        trigger("start"),
        {
          id: "lib",
          type: "library",
          label: "Library",
          position: { x: 0, y: 0 },
          settings: { libraryId: "flow-a", label: "android", overrides },
        },
      ],
      [thenWire("start", "lib")],
    );

  const libraries: LibraryLookup = (flowId) =>
    ({
      "flow-a": {
        name: "Android",
        kind: "node-library" as const,
        sessions: [],
        uses: [],
        sends: [],
      },
      "flow-b": {
        name: "iOS App",
        kind: "node-library" as const,
        sessions: [],
        uses: [],
        sends: [],
      },
    })[flowId];

  const addLibrary = (before: Flow, libraryId: string) =>
    checkEdit(
      before,
      "add_node",
      { type: "library", label: "Given", settings: { libraryId } },
      libraries,
    );

  it("adds a library node labelled from its library's name, ignoring the given label", () => {
    const before = blueprint();
    const label = libraryLabelFor(before, "Android");

    expect(addLibrary(before, "flow-a")).toEqual({
      ok: true,
      edit: expect.objectContaining({
        type: "library",
        label,
        settings: { libraryId: "flow-a", label, overrides: {} },
      }),
    });
    expect(label).toBe("android");
  });

  it("labels a second use of a library with the next free suffix", () => {
    const before = withLibrary();
    const label = libraryLabelFor(before, "Android");

    expect(addLibrary(before, "flow-a")).toMatchObject({
      ok: true,
      edit: { label, settings: { label } },
    });
    expect(label).toBe("android-2");
  });

  it("labels a library it cannot find from the name fallback, leaving the refusal to the caller", () => {
    const before = blueprint();
    const label = libraryLabelFor(before, "library");

    expect(addLibrary(before, "ghost")).toMatchObject({
      ok: true,
      edit: { label, settings: { libraryId: "ghost", label } },
    });
  });

  it("re-derives the label from a new libraryId, not counting the node itself", () => {
    const before = withLibrary();
    const label = libraryLabelFor(before, "Android", "lib");

    expect(
      checkEdit(
        before,
        "change_node",
        { nodeId: "lib", settings: { libraryId: "flow-a-copy" } },
        (id) => (id === "flow-a-copy" ? libraries("flow-a") : undefined),
      ),
    ).toMatchObject({ ok: true, edit: { label, settings: { libraryId: "flow-a-copy", label } } });
    expect(label).toBe("android");
  });

  it("supersedes a label given with a new libraryId", () => {
    const label = libraryLabelFor(withLibrary(), "iOS App", "lib");

    expect(
      checkEdit(
        withLibrary(),
        "change_node",
        { nodeId: "lib", label: "Mine", settings: { libraryId: "flow-b" } },
        libraries,
      ),
    ).toMatchObject({ ok: true, edit: { label, settings: { label } } });
  });

  it("drops the old library's overrides on a new libraryId", () => {
    const result = checkEdit(
      withLibrary({ s1: { model: "opus" } }),
      "change_node",
      { nodeId: "lib", settings: { libraryId: "flow-b" } },
      libraries,
    );

    expect(result).toMatchObject({ ok: true, edit: { settings: { overrides: {} } } });
  });

  it("keeps the overrides given with a new libraryId", () => {
    const result = checkEdit(
      withLibrary({ s1: { model: "opus" } }),
      "change_node",
      { nodeId: "lib", settings: { libraryId: "flow-b", overrides: { s2: { repo: "web" } } } },
      libraries,
    );

    expect(result).toMatchObject({
      ok: true,
      edit: { settings: { overrides: { s2: { repo: "web" } } } },
    });
  });

  it("leaves the label and overrides alone when the libraryId stays the same", () => {
    const result = checkEdit(
      withLibrary({ s1: { model: "opus" } }),
      "change_node",
      { nodeId: "lib", label: "Mine", settings: { libraryId: "flow-a" } },
      libraries,
    );

    expect(result).toEqual({
      ok: true,
      edit: {
        tool: "change_node",
        nodeId: "lib",
        label: "Mine",
        settings: { libraryId: "flow-a", label: "android", overrides: { s1: { model: "opus" } } },
      },
    });
  });

  it.each([
    ["its label setting", { nodeId: "lib", settings: { label: "ios" } }],
    ["its node label alone", { nodeId: "lib", label: "iOS app" }],
  ])("accepts a change_node to %s", (_, input) => {
    expect(checkEdit(withLibrary(), "change_node", input)).toMatchObject({ ok: true });
  });

  it("applies a label-only change_node as given", () => {
    expect(
      checkEdit(withLibrary(), "change_node", { nodeId: "lib", label: "iOS app" }, libraries),
    ).toEqual({ ok: true, edit: { tool: "change_node", nodeId: "lib", label: "iOS app" } });
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
  ])("a well-formed %s", (name, input) => {
    expect(checkEdit(blueprint(), name, input)).toMatchObject({ ok: true });
  });

  it("tidy_layout with no input, as an edit that carries nothing", () => {
    expect(checkEdit(blueprint(), "tidy_layout", {})).toEqual({
      ok: true,
      edit: { tool: "tidy_layout" },
    });
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
  const strayBranch = (nodes: unknown[]) =>
    flow([...nodes, agent("a3")], [...parallelWires, wire("split", "out", "a3", "in")]);

  it("reports the problem an edit leaves when an agent branch is not wired onward", () => {
    const before = flow(parallelNodes, parallelWires);

    expect(newProblems(before, strayBranch(parallelNodes))).toEqual([
      expect.objectContaining({ rule: "parallel-section", node: "split" }),
    ]);
  });

  it("does not repeat problems the blueprint already had", () => {
    const blankAgent = agent("a1", { settings: { instructions: "" } });
    const nodes = [parallelNodes[0], parallelNodes[1], blankAgent, ...parallelNodes.slice(3)];
    const before = flow(nodes, parallelWires);

    expect(newProblems(before, strayBranch(nodes))).toEqual([
      expect.objectContaining({ rule: "parallel-section", node: "split" }),
    ]);
  });

  it("reports nothing for an edit that adds no problem", () => {
    const before = flow(parallelNodes, parallelWires);
    const after = flow(
      parallelNodes.map((node) => (node.id === "a1" ? { ...node, label: "Renamed" } : node)),
      parallelWires,
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
    const mainNodes = [trigger("start"), agent("a"), output("stop")];
    const mainWires = [thenWire("start", "a"), thenWire("a", "stop")];
    const before = flow(mainNodes, mainWires);

    it("reports nothing for a blank Agent added off the main flow", () => {
      const after = flow([...mainNodes, blankAgent], mainWires);

      expect(newProblems(before, after)).toEqual([]);
    });

    it("reports the blank Agent's settings once it is added on the main flow", () => {
      const after = flow(
        [...mainNodes, blankAgent],
        [thenWire("start", "a"), thenWire("a", "blank"), thenWire("blank", "stop")],
      );

      expect(newProblems(before, after)).toEqual([
        expect.objectContaining({ rule: "required-settings", node: "blank" }),
      ]);
    });

    it.each([
      ["an Agent with no instructions", agent("loose", { settings: { instructions: "" } }), "out"],
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

    it("reports nothing when Start is wired to an unfilled Agent while Stop is still loose", () => {
      const nodes = [
        trigger("start"),
        agent("loose", { settings: { instructions: "" } }),
        output("stop"),
      ];

      expect(newProblems(flow(nodes, []), flow(nodes, [thenWire("start", "loose")]))).toEqual([]);
    });

    it("reports a cycle drawn off the main flow once a wire brings it onto it", () => {
      const nodes = [trigger("start"), output("stop"), agent("a"), agent("b")];
      const mainFlow = [thenWire("start", "stop"), thenWire("a", "b")];
      const looseCycle = flow(nodes, [...mainFlow, thenWire("b", "a")]);
      const wiredIn = flow(nodes, [...mainFlow, thenWire("b", "a"), thenWire("start", "a")]);

      expect(newProblems(flow(nodes, mainFlow), looseCycle)).toEqual([]);
      expect(newProblems(looseCycle, wiredIn)).toEqual(
        expect.arrayContaining([expect.objectContaining({ rule: "no-cycle" })]),
      );
    });
  });

  describe("with a Start in every container", () => {
    const blank = agent("blank", { settings: { instructions: "" } });
    const baseNodes = [
      trigger("ws-start"),
      output("ws-stop"),
      trigger("s1-start"),
      agent("a"),
      output("s1-stop"),
      trigger("s2-start"),
      agent("b"),
      output("s2-stop"),
    ];
    const baseWires = [
      thenWire("ws-start", "ws-stop"),
      thenWire("s1-start", "a"),
      thenWire("a", "s1-stop"),
      thenWire("s2-start", "b"),
    ];
    const threeContainers = (extra: unknown[], wires: unknown[]) =>
      flow([...baseNodes, ...extra], [...baseWires, ...wires], flowSettings, {
        containers: [
          workspaceContainer(["ws-start", "ws-stop"]),
          sessionContainer(["s1-start", "a", "s1-stop"]),
          sessionContainer(["s2-start", "b", "s2-stop", ...(extra.length > 0 ? ["blank"] : [])], {
            id: "session-2",
            name: "review",
          }),
        ],
      });
    const before = threeContainers([], [thenWire("b", "s2-stop")]);

    it("reports a blank Agent added on the second session's main flow", () => {
      const after = threeContainers(
        [blank],
        [thenWire("b", "blank"), thenWire("blank", "s2-stop")],
      );

      expect(newProblems(before, after)).toEqual([
        expect.objectContaining({ rule: "required-settings", node: "blank" }),
      ]);
    });

    it("reports nothing for a blank Agent added off every container's main flow", () => {
      const after = threeContainers([blank], [thenWire("b", "s2-stop")]);

      expect(newProblems(before, after)).toEqual([]);
    });
  });

  describe("tells wires apart by their ends", () => {
    const nodes = [
      trigger("start"),
      agent("a1"),
      agent("a2"),
      agent("p1"),
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

describe("editProblems", () => {
  const blank = (id: string) => agent(id, { settings: { instructions: "" } });
  const mainNodes = [trigger("s-start"), agent("a1"), output("s-stop")];
  const mainWires = [thenWire("s-start", "a1"), thenWire("a1", "s-stop")];
  const withStray = flow([...mainNodes, blank("stray")], mainWires);

  it("reports the problem on a node added off its session's main flow", () => {
    const after = flow([...mainNodes, blank("agent-2")], mainWires);

    expect(editProblems(flow(mainNodes, mainWires), after, ["agent-2"])).toEqual([
      expect.objectContaining({ rule: "required-settings", node: "agent-2" }),
    ]);
  });

  it("reports nothing on a blank node off the main flow when another node is added", () => {
    const after = flow([...mainNodes, blank("stray"), agent("agent-2")], mainWires);

    expect(editProblems(withStray, after, ["agent-2"])).toEqual([]);
  });

  it("reports nothing for a cycle drawn between untouched nodes off the main flow", () => {
    const nodes = [...mainNodes, agent("x"), agent("y")];
    const loose = flow(nodes, [...mainWires, thenWire("x", "y")]);
    const cycle = flow(nodes, [...mainWires, thenWire("x", "y"), thenWire("y", "x")]);

    expect(editProblems(loose, cycle, [])).toEqual([]);
  });

  it("reports nothing when a change keeps a problem the node already had", () => {
    const relabelled = flow([...mainNodes, { ...blank("stray"), label: "Renamed" }], mainWires);

    expect(editProblems(withStray, relabelled, ["stray"])).toEqual([]);
  });
});

describe("change_node on a shared Branch", () => {
  it("reports variable-unique when it renames the Branch to an earlier Branch's variable", () => {
    const sharedBranch = {
      ...branch("two", "other"),
      settings: { variable: "other", shared: true },
    };
    const wires = [
      thenWire("start", "one"),
      wire("one", "yes", "two", "in"),
      wire("one", "no", "two", "in"),
    ];
    const before = flow([trigger("start"), branch("one", "approved"), sharedBranch], wires);
    const result = checkEdit(before, "change_node", {
      nodeId: "two",
      settings: { variable: "approved" },
    });
    const settings = result.ok && result.edit.tool === "change_node" ? result.edit.settings : {};
    const after = {
      ...before,
      nodes: before.nodes.map((node) =>
        node.id === "two" ? ({ ...node, settings } as typeof node) : node,
      ),
    };

    expect(editProblems(before, after, ["two"])).toEqual([
      expect.objectContaining({ rule: "variable-unique", node: "two" }),
    ]);
  });
});

describe("connections between sessions", () => {
  const sessions = (connections: { id: string; between: [string, string] }[] = []): Flow => ({
    ...flow(
      [trigger("w-start"), output("w-stop"), trigger("a1"), output("a2"), trigger("i1")],
      [thenWire("w-start", "w-stop"), thenWire("a1", "a2")],
      flowSettings,
      {
        containers: [
          workspaceContainer(["w-start", "w-stop"]),
          sessionContainer(["a1", "a2"], { id: "android", name: "Android app" }),
          sessionContainer(["i1"], { id: "ios", name: "iOS app" }),
        ],
      },
    ),
    ...(connections.length === 0 ? {} : { connections }),
  });
  const joined = () => sessions([{ id: "c1", between: ["android", "ios"] }]);
  const notTwoSessions = "A connection can only join two session containers.";

  const refusals: [string, Flow, [string, string], string][] = [
    [
      "the same session on both ends",
      sessions(),
      ["android", "android"],
      "A session cannot connect to itself.",
    ],
    [
      "a connected pair",
      joined(),
      ["android", "ios"],
      "Android app and iOS app are already connected.",
    ],
    [
      "a connected pair reversed",
      joined(),
      ["ios", "android"],
      "Android app and iOS app are already connected.",
    ],
    ["the workspace", sessions(), ["workspace-1", "android"], notTwoSessions],
    ["the workspace as the second end", sessions(), ["android", "workspace-1"], notTwoSessions],
    ["a node", sessions(), ["android", "a1"], notTwoSessions],
    ["an unknown id", sessions(), ["android", "nowhere"], notTwoSessions],
  ];

  it.each(refusals)(
    "connectionRefusal refuses %s with the canvas's reason",
    (_name, before, between, reason) => {
      expect(connectionRefusal(before, between)).toBe(reason);
    },
  );

  it("connectionRefusal lets two unconnected sessions connect", () => {
    expect(connectionRefusal(sessions(), ["android", "ios"])).toBeUndefined();
  });

  it.each(refusals)("checkEdit refuses add_connection for %s", (_name, before, between, reason) => {
    const untouched = structuredClone(before);

    expect(checkEdit(before, "add_connection", { between })).toEqual({ ok: false, reason });
    expect(before).toEqual(untouched);
  });

  it("checkEdit accepts add_connection for two unconnected sessions", () => {
    expect(checkEdit(sessions(), "add_connection", { between: ["android", "ios"] })).toEqual({
      ok: true,
      edit: { tool: "add_connection", between: ["android", "ios"] },
    });
  });

  it("checkEdit refuses delete_connection for a connection not in the blueprint", () => {
    expect(checkEdit(joined(), "delete_connection", { connectionId: "c9" })).toEqual({
      ok: false,
      reason: 'No connection "c9" in the blueprint.',
    });
  });

  it("checkEdit accepts delete_connection for a connection in the blueprint", () => {
    expect(checkEdit(joined(), "delete_connection", { connectionId: "c1" })).toEqual({
      ok: true,
      edit: { tool: "delete_connection", connectionId: "c1" },
    });
  });

  it.each([
    ["no connections", [], "c1"],
    ["c1 taken", [{ id: "c1", between: ["android", "ios"] }], "c2"],
    ["a gap at c1", [{ id: "c2", between: ["android", "ios"] }], "c1"],
  ] as [string, { id: string; between: [string, string] }[], string][])(
    "nextConnectionId with %s",
    (_name, connections, id) => {
      expect(nextConnectionId(sessions(connections))).toBe(id);
    },
  );
});
