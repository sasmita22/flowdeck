import { MarkerType } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import {
  alignedEnds,
  edgeId,
  FRAME_PADDING,
  toViewEdges,
  toViewNodes,
} from "../../../../src/app/renderer/canvas/view.js";
import { containerText } from "../../../../src/app/renderer/canvas/frames.js";
import { BAR_MIN_HEIGHT, nodeLook } from "../../../../src/app/renderer/nodes/look.js";
import type { Flow, NodeType, Wire } from "../../../../src/core/flow/schema.js";
import {
  agent,
  ask,
  branch,
  flow,
  forEach,
  fork,
  gate,
  hardstop,
  join,
  loop,
  output,
  thenWire,
  trigger,
  wire,
} from "../../../fixtures/flow-builders.js";

const twoNodes = () =>
  flow(
    [
      { ...agent("agent-1"), label: "Plan", position: { x: 120, y: 80 } },
      { ...gate("gate-1"), label: "Check", position: { x: 300, y: 40 } },
    ],
    [thenWire("agent-1", "gate-1")],
  );

const thenBetween = (from: string, fromPort: string, to: string, toPort: string): Wire => ({
  kind: "then",
  from: { node: from, port: fromPort },
  to: { node: to, port: toPort },
});

describe("toViewNodes", () => {
  it("maps each node to id, type, position, selected and label, in flow order", () => {
    expect(toViewNodes(twoNodes(), [], {}, null)).toEqual([
      {
        id: "agent-1",
        type: "agent",
        position: { x: 120, y: 80 },
        selected: false,
        data: { label: "Plan", highlighted: false, ignored: false },
      },
      {
        id: "gate-1",
        type: "gate",
        position: { x: 300, y: 40 },
        selected: false,
        data: { label: "Check", highlighted: false, ignored: false },
      },
    ]);
  });

  it("marks selected only the nodes whose ids are in the selection", () => {
    const view = toViewNodes(twoNodes(), ["gate-1"], {}, null);

    expect(view.map((node) => [node.id, node.selected])).toEqual([
      ["agent-1", false],
      ["gate-1", true],
    ]);
  });

  it("ignores selection ids that are not in the flow", () => {
    const view = toViewNodes(twoNodes(), ["gone-1"], {}, null);

    expect(view.map((node) => node.selected)).toEqual([false, false]);
  });

  it("takes the drag position when one is held, else the flow position", () => {
    const view = toViewNodes(twoNodes(), [], { "agent-1": { x: 500, y: 600 } }, null);

    expect(view.map((node) => [node.id, node.position])).toEqual([
      ["agent-1", { x: 500, y: 600 }],
      ["gate-1", { x: 300, y: 40 }],
    ]);
  });

  it("marks highlighted only the node whose id is given, without selecting any node", () => {
    const view = toViewNodes(twoNodes(), [], {}, "gate-1");

    expect(view.map((node) => [node.id, node.data.highlighted, node.selected])).toEqual([
      ["agent-1", false, false],
      ["gate-1", true, false],
    ]);
  });

  it("highlights no node when given null", () => {
    const view = toViewNodes(twoNodes(), [], {}, null);

    expect(view.map((node) => node.data.highlighted)).toEqual([false, false]);
  });

  it("returns no entries for an empty flow", () => {
    expect(toViewNodes(flow([], []), [], {}, null)).toEqual([]);
  });
});

const ignoredOf = (source: Flow) =>
  toViewNodes(source, [], {}, null).map((node) => [node.id, node.data.ignored]);

describe("toViewNodes and the main flow", () => {
  it("marks ignored the nodes off the main flow, and only those", () => {
    const source = flow(
      [trigger("start"), agent("a"), output("stop"), agent("b"), agent("c"), agent("d")],
      [thenWire("start", "a"), thenWire("a", "stop"), thenWire("c", "d")],
    );

    expect(ignoredOf(source)).toEqual([
      ["start", false],
      ["a", false],
      ["stop", false],
      ["b", true],
      ["c", true],
      ["d", true],
    ]);
  });

  it("marks ignored a loose Loop's frame and its body, and keeps a wired For each", () => {
    const source = flow(
      [
        trigger("start"),
        forEach("E"),
        agent("x", { parent: "E" }),
        output("stop"),
        loop("L"),
        agent("y", { parent: "L" }),
      ],
      [thenWire("start", "x"), thenWire("x", "stop")],
    );

    expect(ignoredOf(source)).toEqual([
      ["loop-frame-L", true],
      ["foreach-frame-E", false],
      ["start", false],
      ["E", false],
      ["x", false],
      ["stop", false],
      ["L", true],
      ["y", true],
    ]);
  });

  it("marks ignored a loose For each frame and a loose Fork bar", () => {
    const source = flow(
      [
        trigger("start"),
        output("stop"),
        forEach("E"),
        agent("x", { parent: "E" }),
        fork("F"),
        agent("p"),
      ],
      [thenWire("start", "stop"), thenWire("F", "p")],
    );

    expect(ignoredOf(source)).toEqual([
      ["foreach-frame-E", true],
      ["start", false],
      ["stop", false],
      ["E", true],
      ["x", true],
      ["F", true],
      ["p", true],
    ]);
  });

  it("marks nothing ignored when there is no Start", () => {
    const source = flow(
      [agent("a"), output("stop"), loop("L"), agent("y", { parent: "L" })],
      [thenWire("a", "stop")],
    );

    expect(ignoredOf(source)).toEqual([
      ["loop-frame-L", false],
      ["a", false],
      ["stop", false],
      ["L", false],
      ["y", false],
    ]);
  });

  it("marks nothing ignored when there are two Starts", () => {
    const source = flow(
      [trigger("one"), trigger("two"), agent("a"), output("stop")],
      [thenWire("one", "a"), thenWire("a", "stop")],
    );

    expect(ignoredOf(source).map(([, ignored]) => ignored)).toEqual([false, false, false, false]);
  });
});

const framed = (source: Flow, nodes: string[]): Flow => ({
  ...source,
  session: { ...source.session, name: "build", frame: { nodes } },
});

const threeApart = () =>
  flow(
    [
      { ...agent("A"), position: { x: 100, y: 50 } },
      { ...agent("B"), position: { x: 400, y: 300 } },
      { ...agent("C"), position: { x: 900, y: 900 } },
    ],
    [],
  );

type Rect = { position: { x: number; y: number }; width: number; height: number };

const boxOf = (type: NodeType, x: number, y: number): Rect => ({
  position: { x, y },
  ...nodeLook(type).box,
});

const grown = (rects: Rect[]): Rect => {
  const left = Math.min(...rects.map((r) => r.position.x)) - FRAME_PADDING;
  const top = Math.min(...rects.map((r) => r.position.y)) - FRAME_PADDING;
  const right = Math.max(...rects.map((r) => r.position.x + r.width)) + FRAME_PADDING;
  const bottom = Math.max(...rects.map((r) => r.position.y + r.height)) + FRAME_PADDING;
  return { position: { x: left, y: top }, width: right - left, height: bottom - top };
};

const enclosing = (boxes: { type: NodeType; x: number; y: number }[]) =>
  grown(boxes.map(({ type, x, y }) => boxOf(type, x, y)));

describe("toViewNodes and the session", () => {
  it("draws no session frame, even for a blueprint saved with one", () => {
    const source = framed(threeApart(), ["A", "B"]);

    expect(toViewNodes(source, [], {}, null).map((node) => node.id)).toEqual(["A", "B", "C"]);
  });
});

describe("toViewNodes delete lock", () => {
  it("lets a hard stop be deleted like any node", () => {
    const [node] = toViewNodes(flow([hardstop("H")], []), [], {}, null);

    expect(node).not.toHaveProperty("deletable");
  });

  it("adds no deletable field to any other type", () => {
    const source = flow(
      [
        trigger("T"),
        agent("P"),
        agent("S"),
        agent("G"),
        gate("K"),
        ask("Q"),
        loop("L"),
        output("O"),
      ],
      [],
    );

    const nodes = toViewNodes(source, [], {}, null).filter((node) => node.type !== "loop-frame");

    expect(nodes.map((node) => node.id)).toEqual(["T", "P", "S", "G", "K", "Q", "L", "O"]);
    for (const node of nodes) expect(node).not.toHaveProperty("deletable");
  });
});

describe("toViewNodes with a branch", () => {
  const branchData = (variables: Flow["session"]["buildConfig"]["variables"]) => {
    const base = flow(
      [{ ...branch("B", "e2e"), settings: { variable: "e2e" }, label: "E2E?" }],
      [],
    );
    const source = { ...base, session: { ...base.session, buildConfig: { variables } } };
    return toViewNodes(source, [], {}, null).find((node) => node.id === "B")?.data;
  };

  it("sub-lines the branch with the yes/no variable it follows", () => {
    expect(branchData([{ name: "e2e", kind: "yesno", default: true }])).toEqual({
      label: "E2E?",
      highlighted: false,
      ignored: false,
      sub: "e2e",
    });
  });

  it("names the variable whatever its default, and when it is not declared", () => {
    expect(branchData([{ name: "e2e", kind: "yesno", default: false }])?.sub).toBe("e2e");
    expect(branchData([{ name: "e2e", kind: "yesno" }])?.sub).toBe("e2e");
    expect(branchData([])?.sub).toBe("e2e");
  });

  it("adds no sub to any other type", () => {
    const source = flow(
      [
        trigger("T"),
        agent("P"),
        agent("S"),
        agent("G"),
        gate("K"),
        ask("Q"),
        hardstop("H"),
        output("O"),
        { ...branch("B", "e2e"), settings: { variable: "e2e" } },
      ],
      [],
    );

    const others = toViewNodes(source, [], {}, null).filter((node) => node.id !== "B");

    expect(others.map((node) => node.id)).toEqual(["T", "P", "S", "G", "K", "Q", "H", "O"]);
    for (const node of others) expect(node.data).not.toHaveProperty("sub");
  });
});

describe("toViewEdges", () => {
  it("maps each wire to its id and its source and target nodes and handles", () => {
    expect(toViewEdges(twoNodes())).toEqual([
      {
        id: "agent-1:out->gate-1:in",
        source: "agent-1",
        sourceHandle: "out",
        target: "gate-1",
        targetHandle: "in",
        markerEnd: { type: MarkerType.ArrowClosed },
      },
    ]);
  });

  it("keeps one entry per wire in flow order", () => {
    const source = flow(
      [agent("A"), agent("B"), agent("C")],
      [thenWire("A", "B"), thenWire("B", "C"), thenWire("A", "C")],
    );

    expect(toViewEdges(source).map((edge) => edge.id)).toEqual([
      "A:out->B:in",
      "B:out->C:in",
      "A:out->C:in",
    ]);
  });

  it("returns no entries for a flow without wires", () => {
    expect(toViewEdges(flow([agent("A")], []))).toEqual([]);
  });

  it("ends every wire in a closed arrowhead", () => {
    const source = flow(
      [agent("A"), agent("B"), agent("C")],
      [thenWire("A", "B"), thenWire("B", "C")],
    );

    expect(toViewEdges(source).map((edge) => edge.markerEnd)).toEqual([
      { type: MarkerType.ArrowClosed },
      { type: MarkerType.ArrowClosed },
    ]);
  });
});

describe("toViewEdges selection", () => {
  it("marks the selected wires selected and leaves the rest alone", () => {
    const source = flow(
      [agent("A"), agent("B"), agent("C")],
      [thenWire("A", "B"), thenWire("B", "C")],
    );

    expect(toViewEdges(source, ["B:out->C:in"]).map((edge) => edge.selected)).toEqual([
      undefined,
      true,
    ]);
  });
});

describe("toViewEdges selected arrowhead", () => {
  it("draws the selected wire's arrowhead in the selection colour and leaves the rest plain", () => {
    const source = flow(
      [agent("A"), agent("B"), agent("C")],
      [thenWire("A", "B"), thenWire("B", "C")],
    );

    expect(toViewEdges(source, ["B:out->C:in"]).map((edge) => edge.markerEnd)).toEqual([
      { type: MarkerType.ArrowClosed },
      { type: MarkerType.ArrowClosed, color: "var(--select)" },
    ]);
  });
});

describe("toViewEdges from a Branch", () => {
  it("labels the wires leaving yes and no with their port", () => {
    const source = flow(
      [
        trigger("T", { settings: { flags: { e2e: true } } }),
        branch("B", "e2e"),
        agent("Y"),
        agent("N"),
      ],
      [thenWire("T", "B"), wire("B", "yes", "Y", "in"), wire("B", "no", "N", "in")],
    );

    expect(toViewEdges(source).map(({ id, type, data }) => ({ id, type, data }))).toEqual([
      { id: "T:out->B:in", type: undefined, data: undefined },
      { id: "B:yes->Y:in", type: "branch", data: { label: "yes" } },
      { id: "B:no->N:in", type: "branch", data: { label: "no" } },
    ]);
  });
});

describe("edgeId", () => {
  it("is built from both endpoints as from.node:from.port->to.node:to.port", () => {
    expect(edgeId(thenBetween("agent-1", "out", "gate-1", "in"))).toBe("agent-1:out->gate-1:in");
  });

  it("gives different wires different ids", () => {
    const wires = flow(
      [agent("A"), agent("B"), agent("C")],
      [
        thenWire("A", "B"),
        thenWire("B", "A"),
        thenWire("A", "C"),
        wire("A", "done", "B", "in"),
        wire("A", "out", "B", "start"),
      ],
    ).wires;

    expect(new Set(wires.map(edgeId)).size).toBe(wires.length);
  });
});

const parallelSection = () =>
  flow(
    [
      { ...trigger("T"), position: { x: -200, y: 10 } },
      { ...fork("F"), position: { x: 10, y: 10 } },
      { ...agent("b1"), position: { x: 70, y: 10 } },
      { ...agent("b2"), position: { x: 70, y: 90 } },
      { ...agent("b3"), position: { x: 70, y: 170 } },
      { ...join("J"), position: { x: 270, y: 10 } },
      { ...output("O"), position: { x: 400, y: 10 } },
    ],
    [
      thenWire("T", "F"),
      thenWire("F", "b1"),
      thenWire("F", "b2"),
      thenWire("F", "b3"),
      thenWire("b1", "J"),
      thenWire("b2", "J"),
      thenWire("b3", "J"),
      thenWire("J", "O"),
    ],
  );

const viewOf = (view: ReturnType<typeof toViewNodes>, id: string) =>
  view.find((node) => node.id === id);

describe("toViewNodes with a parallel section", () => {
  it("stretches the fork and join bars over every branch they span", () => {
    const view = toViewNodes(parallelSection(), [], {}, null);

    expect(viewOf(view, "F")).toMatchObject({
      position: { x: 10, y: 10 },
      width: 28,
      height: 208,
    });
    expect(viewOf(view, "J")).toMatchObject({
      position: { x: 270, y: 10 },
      width: 28,
      height: 208,
    });
  });

  it("takes the bar's x from its drag position and its y from its branches", () => {
    const view = toViewNodes(parallelSection(), [], { F: { x: 40, y: 500 } }, null);

    expect(viewOf(view, "F")).toMatchObject({ position: { x: 40, y: 10 }, height: 208 });
  });

  it("gives a fork with no wires its look box at its stored position", () => {
    const [node] = toViewNodes(
      flow([{ ...fork("F"), position: { x: 30, y: 60 } }], []),
      [],
      {},
      null,
    );

    expect(node).toMatchObject({
      id: "F",
      position: { x: 30, y: 60 },
      width: 28,
      height: BAR_MIN_HEIGHT,
    });
  });

  it("gives a join with no wires its look box", () => {
    const [node] = toViewNodes(flow([join("J")], []), [], {}, null);

    expect(node).toMatchObject({ id: "J", width: 28, height: BAR_MIN_HEIGHT });
  });

  it("keeps a bar over branches shorter than its tag at the minimum height", () => {
    const view = toViewNodes(
      flow(
        [
          { ...fork("F"), position: { x: 10, y: 10 } },
          { ...agent("b1"), position: { x: 70, y: 30 } },
          { ...join("J"), position: { x: 270, y: 10 } },
        ],
        [thenWire("F", "b1"), thenWire("b1", "J")],
      ),
      [],
      {},
      null,
    );

    for (const id of ["F", "J"]) {
      expect(viewOf(view, id)).toMatchObject({
        position: { x: expect.any(Number), y: 30 },
        height: BAR_MIN_HEIGHT,
      });
    }
  });
});

const directWire = (joinY = 300) =>
  flow(
    [
      { ...fork("F"), position: { x: 10, y: 10 } },
      { ...join("J"), position: { x: 270, y: joinY } },
    ],
    [thenWire("F", "J")],
  );

const directWireAndBox = () =>
  flow(
    [
      { ...fork("F"), position: { x: 10, y: 10 } },
      { ...agent("b1"), position: { x: 70, y: 90 } },
      { ...join("J"), position: { x: 270, y: 0 } },
    ],
    [thenWire("F", "J"), thenWire("F", "b1")],
  );

describe("toViewNodes with a fork wired straight to a join", () => {
  it("draws each bar at its own stored position with its own look box", () => {
    const view = toViewNodes(directWire(), [], {}, null);

    expect(viewOf(view, "F")).toMatchObject({
      position: { x: 10, y: 10 },
      ...nodeLook("fork").box,
    });
    expect(viewOf(view, "J")).toMatchObject({
      position: { x: 270, y: 300 },
      ...nodeLook("join").box,
    });
  });

  it("draws the dragged bar at its drag position and leaves the other bar where it is", () => {
    const view = toViewNodes(directWire(), [], { F: { x: 40, y: 500 } }, null);

    expect(viewOf(view, "F")).toMatchObject({ position: { x: 40, y: 500 } });
    expect(viewOf(view, "J")).toMatchObject({ position: { x: 270, y: 300 } });
  });

  it("follows a dragged join the same way", () => {
    const view = toViewNodes(directWire(), [], { J: { x: 270, y: -150 } }, null);

    expect(viewOf(view, "J")).toMatchObject({ position: { x: 270, y: -150 } });
    expect(viewOf(view, "F")).toMatchObject({ position: { x: 10, y: 10 } });
  });

  it("still stretches a fork over a box it is also wired to", () => {
    const view = toViewNodes(directWireAndBox(), [], {}, null);

    expect(viewOf(view, "F")).toMatchObject({
      position: { x: 10, y: 90 },
      height: Math.max(BAR_MIN_HEIGHT, nodeLook("agent").box.height),
    });
  });
});

describe("toViewEdges with a parallel section", () => {
  const edges = () => new Map(toViewEdges(parallelSection()).map((edge) => [edge.id, edge]));

  it("aligns each wire out of a fork to its target", () => {
    for (const branch of ["b1", "b2", "b3"]) {
      expect(edges().get(`F:out->${branch}:in`)).toMatchObject({
        type: "aligned",
        data: { align: "target" },
      });
    }
  });

  it("aligns each wire into a join to its source", () => {
    for (const branch of ["b1", "b2", "b3"]) {
      expect(edges().get(`${branch}:out->J:in`)).toMatchObject({
        type: "aligned",
        data: { align: "source" },
      });
    }
  });

  it("leaves a fork-to-join wire unaligned and keeps a fork-to-box wire aligned to its target", () => {
    const direct = new Map(toViewEdges(directWireAndBox()).map((edge) => [edge.id, edge]));

    expect(direct.get("F:out->J:in")).toBeDefined();
    expect(direct.get("F:out->J:in")).not.toHaveProperty("type");
    expect(direct.get("F:out->J:in")).not.toHaveProperty("data");
    expect(direct.get("F:out->b1:in")).toMatchObject({
      type: "aligned",
      data: { align: "target" },
    });
  });

  it("leaves wires into a fork and out of a join unchanged", () => {
    for (const id of ["T:out->F:in", "J:out->O:in"]) {
      const edge = edges().get(id);
      expect(edge).toBeDefined();
      expect(edge).not.toHaveProperty("type");
      expect(edge).not.toHaveProperty("data");
    }
  });
});

describe("alignedEnds", () => {
  const ends = { sourceX: 38, sourceY: 114, targetX: 70, targetY: 34 };

  it("levels the source with the target for align target", () => {
    expect(alignedEnds(ends, "target")).toEqual({ ...ends, sourceY: 34 });
  });

  it("levels the target with the source for align source", () => {
    expect(alignedEnds(ends, "source")).toEqual({ ...ends, targetY: 114 });
  });
});

describe("toViewNodes for a blank label", () => {
  const labelOf = (node: ReturnType<typeof agent>) =>
    toViewNodes(flow([node], []), [], {}, null).find((view) => view.id === node.id)?.data.label;

  it.each([
    ["agent", "", "Agent"],
    ["agent", "   ", "Agent"],
    ["loop", "", "Loop"],
  ] as const)("names a %s labelled %j by its type, %j", (type, label, shown) => {
    const node = type === "loop" ? loop("N") : agent("N");

    expect(labelOf({ ...node, label })).toBe(shown);
  });

  it("keeps a label that has text", () => {
    expect(labelOf({ ...agent("N"), label: "Run tests" })).toBe("Run tests");
  });
});

describe("toViewNodes for Loop and For each labels", () => {
  it("gives a Loop its cap and a For each its list file as a sub-line", () => {
    const source = flow(
      [loop("L", { settings: { cap: 5 } }), forEach("E", { file: "plan.md" }), agent("A")],
      [],
    );
    const data = Object.fromEntries(
      toViewNodes(source, [], {}, null).map((node) => [node.id, node.data]),
    );

    expect(data["L"]?.sub).toBe("max 5");
    expect(data["E"]?.sub).toBe("plan.md");
    expect(data["A"]).not.toHaveProperty("sub");
  });

  it("widens a frame so a long Loop label stays inside it", () => {
    const frameWidth = (label: string) =>
      toViewNodes(flow([{ ...loop("L"), label }], []), [], {}, null).find(
        (node) => node.id === "loop-frame-L",
      )?.width ?? 0;

    expect(frameWidth("Loop")).toBe(nodeLook("loop").box.width + 2 * FRAME_PADDING);
    expect(frameWidth("until every test passes on the build")).toBeGreaterThan(frameWidth("Loop"));
  });
});

describe("toViewNodes with a wide node", () => {
  const long = "Review every changed file against the plan and list each gap";

  it("widens a Loop frame around a body Agent with a 60-character label", () => {
    const frameWidth = (label: string) =>
      viewOf(
        toViewNodes(
          flow(
            [
              { ...loop("L"), position: { x: 0, y: 0 } },
              { ...agent("A", { parent: "L" }), label, position: { x: 0, y: 90 } },
            ],
            [],
          ),
          [],
          {},
          null,
        ),
        "loop-frame-L",
      )?.width ?? 0;

    expect(frameWidth(long)).toBeGreaterThan(frameWidth("Review"));
  });

  it("keeps the Fork and Join bars 28 wide beside a wide branch", () => {
    const source = parallelSection();
    const wide = {
      ...source,
      nodes: source.nodes.map((node) => (node.id === "b1" ? { ...node, label: long } : node)),
    };
    const view = toViewNodes(wide, [], {}, null);

    expect(viewOf(view, "F")?.width).toBe(28);
    expect(viewOf(view, "J")?.width).toBe(28);
  });
});

describe("toViewNodes while a container is dragged", () => {
  const dragged = () =>
    flow(
      [
        { ...loop("L"), position: { x: 0, y: 0 } },
        { ...agent("X", { parent: "L" }), position: { x: 0, y: 100 } },
        { ...agent("A"), position: { x: 600, y: 0 } },
      ],
      [],
    );

  it("moves the body and the frame with the container's live drag", () => {
    const nodes = toViewNodes(dragged(), [], { L: { x: 50, y: 20 } }, null);
    const byId = Object.fromEntries(nodes.map((node) => [node.id, node]));

    expect(byId["X"]?.position).toEqual({ x: 50, y: 120 });
    expect(byId["A"]?.position).toEqual({ x: 600, y: 0 });
    expect(byId["loop-frame-L"]).toMatchObject(
      enclosing([
        { type: "loop", x: 50, y: 20 },
        { type: "agent", x: 50, y: 120 },
      ]),
    );
  });

  it("follows a body node's own drag position over its container's", () => {
    const nodes = toViewNodes(dragged(), [], { L: { x: 50, y: 20 }, X: { x: 300, y: 300 } }, null);

    expect(nodes.find((node) => node.id === "X")?.position).toEqual({ x: 300, y: 300 });
  });
});

describe("containerText", () => {
  it.each([
    ["loop", "Loop", "max 3", "LOOP · max 3"],
    ["loop", "review", "max 3", "LOOP · review · max 3"],
    ["foreach", "For each", "plan.md", "EACH · plan.md"],
    ["foreach", "each plan unit", "plan.md", "EACH · each plan unit · plan.md"],
  ] as const)("names a %s labelled %s only when renamed", (type, label, sub, text) => {
    expect(containerText(type, label, sub)).toBe(text);
  });

  it.each(["", "   "])("leaves out a blank label %j", (label) => {
    expect(containerText("loop", label, "max 3")).toBe("LOOP · max 3");
  });
});
