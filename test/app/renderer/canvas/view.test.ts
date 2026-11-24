import { MarkerType } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import {
  alignedEnds,
  connectionPorts,
  edgeId,
  FRAME_PADDING,
  frameOwnerId,
  routeConnection,
  toViewEdges,
  toViewNodes,
} from "../../../../src/app/renderer/canvas/view.js";
import { containerText, sideLabelSpan } from "../../../../src/app/renderer/canvas/frames.js";
import { BAR_MIN_HEIGHT, nodeLook } from "../../../../src/app/renderer/nodes/look.js";
import {
  parseFlow,
  type Flow,
  type NodeType,
  type Wire,
} from "../../../../src/core/flow/schema.js";
import { flowIn, flowOut } from "../../../../src/core/flow/structure.js";
import {
  agent,
  ask,
  branch,
  flow,
  flowSettings,
  inOneSession,
  forEach,
  fork,
  gate,
  hardstop,
  join,
  loop,
  output,
  sessionContainer,
  thenWire,
  trigger,
  wire,
  workspaceContainer,
} from "../../../fixtures/flow-builders.js";

const nodeViews = (...args: Parameters<typeof toViewNodes>) =>
  toViewNodes(...args).filter((node) => node.type !== "container-frame");

const twoNodes = () =>
  inOneSession(
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
    expect(nodeViews(twoNodes(), [], {}, null)).toEqual([
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
    const view = nodeViews(twoNodes(), ["gate-1"], {}, null);

    expect(view.map((node) => [node.id, node.selected])).toEqual([
      ["agent-1", false],
      ["gate-1", true],
    ]);
  });

  it("ignores selection ids that are not in the flow", () => {
    const view = nodeViews(twoNodes(), ["gone-1"], {}, null);

    expect(view.map((node) => node.selected)).toEqual([false, false]);
  });

  it("takes the drag position when one is held, else the flow position", () => {
    const view = nodeViews(twoNodes(), [], { "agent-1": { x: 500, y: 600 } }, null);

    expect(view.map((node) => [node.id, node.position])).toEqual([
      ["agent-1", { x: 500, y: 600 }],
      ["gate-1", { x: 300, y: 40 }],
    ]);
  });

  it("marks highlighted only the node whose id is given, without selecting any node", () => {
    const view = nodeViews(twoNodes(), [], {}, "gate-1");

    expect(view.map((node) => [node.id, node.data.highlighted, node.selected])).toEqual([
      ["agent-1", false, false],
      ["gate-1", true, false],
    ]);
  });

  it("highlights no node when given null", () => {
    const view = nodeViews(twoNodes(), [], {}, null);

    expect(view.map((node) => node.data.highlighted)).toEqual([false, false]);
  });

  it("returns no entries for an empty flow", () => {
    expect(nodeViews(inOneSession([], []), [], {}, null)).toEqual([]);
  });
});

const ignoredOf = (source: Flow) =>
  nodeViews(source, [], {}, null).map((node) => [node.id, node.data.ignored]);

const throughSession = (source: Flow, session = "session-1"): Flow =>
  parseFlow({
    ...source,
    nodes: [...source.nodes, trigger("canvas-start"), output("canvas-stop")],
    wires: [
      ...source.wires,
      wire("canvas-start", "out", session, flowIn),
      wire(session, flowOut, "canvas-stop", "in"),
    ],
  });

const onCanvasPath: [string, boolean][] = [
  ["canvas-start", false],
  ["canvas-stop", false],
];

describe("toViewNodes and the main flow", () => {
  it("marks ignored the nodes off the main flow, and only those", () => {
    const source = throughSession(
      inOneSession(
        [trigger("start"), agent("a"), output("stop"), agent("b"), agent("c"), agent("d")],
        [thenWire("start", "a"), thenWire("a", "stop"), thenWire("c", "d")],
      ),
    );

    expect(ignoredOf(source)).toEqual([
      ["start", false],
      ["a", false],
      ["stop", false],
      ["b", true],
      ["c", true],
      ["d", true],
      ...onCanvasPath,
    ]);
  });

  it("marks ignored a loose Loop's frame and its body, and keeps a wired For each", () => {
    const source = throughSession(
      inOneSession(
        [
          trigger("start"),
          forEach("E"),
          agent("x", { parent: "E" }),
          output("stop"),
          loop("L"),
          agent("y", { parent: "L" }),
        ],
        [thenWire("start", "x"), thenWire("x", "stop")],
      ),
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
      ...onCanvasPath,
    ]);
  });

  it("marks ignored a loose For each frame and a loose Fork bar", () => {
    const source = throughSession(
      inOneSession(
        [
          trigger("start"),
          output("stop"),
          forEach("E"),
          agent("x", { parent: "E" }),
          fork("F"),
          agent("p"),
        ],
        [thenWire("start", "stop"), thenWire("F", "p")],
      ),
    );

    expect(ignoredOf(source)).toEqual([
      ["foreach-frame-E", true],
      ["start", false],
      ["stop", false],
      ["E", true],
      ["x", true],
      ["F", true],
      ["p", true],
      ...onCanvasPath,
    ]);
  });

  it("marks nothing ignored when there is no canvas Start", () => {
    const source = inOneSession(
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
    const source = inOneSession(
      [trigger("one"), trigger("two"), agent("a"), output("stop")],
      [thenWire("one", "a"), thenWire("a", "stop")],
    );

    expect(ignoredOf(source).map(([, ignored]) => ignored)).toEqual([false, false, false, false]);
  });
});

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

const labelled = (type: NodeType, x: number, y: number, label: string): Rect => {
  const rect = boxOf(type, x, y);
  const sideLabel = type === "trigger" || type === "output" ? sideLabelSpan(label) : 0;
  return { ...rect, width: rect.width + sideLabel };
};

const enclosing = (boxes: { type: NodeType; x: number; y: number; label?: string }[]) =>
  grown(boxes.map(({ type, x, y, label = "" }) => labelled(type, x, y, label)));

const placedAt = <N extends object>(node: N, x: number, y: number) => ({
  ...node,
  position: { x, y },
});

const containersOnCanvas = (): Flow =>
  flow(
    [
      placedAt(trigger("w-start"), 0, 0),
      placedAt(output("w-stop"), 300, 0),
      placedAt(trigger("s"), 0, 400),
      placedAt(agent("a"), 200, 400),
      placedAt(output("t"), 500, 400),
      placedAt(trigger("u"), 0, 800),
      placedAt(agent("b"), 200, 800),
      placedAt(output("v"), 500, 800),
      placedAt(agent("loose"), 200, 1000),
    ],
    [
      thenWire("w-start", "w-stop"),
      thenWire("s", "a"),
      thenWire("a", "t"),
      thenWire("u", "b"),
      thenWire("b", "v"),
    ],
    flowSettings,
    {
      containers: [
        workspaceContainer(["w-start", "w-stop"]),
        sessionContainer(["s", "a", "t"]),
        sessionContainer(["u", "b", "v", "loose"], { id: "session-2", name: "web" }),
      ],
    },
  );

describe("toViewNodes and flow containers", () => {
  const frameOf = (view: ReturnType<typeof toViewNodes>, id: string) =>
    view.find((node) => node.id === `container-frame-${id}`);

  it.each([
    [
      "workspace-1",
      [
        { type: "trigger" as const, x: 0, y: 0, label: "w-start" },
        { type: "output" as const, x: 300, y: 0, label: "w-stop" },
      ],
    ],
    [
      "session-1",
      [
        { type: "trigger" as const, x: 0, y: 400, label: "s" },
        { type: "agent" as const, x: 200, y: 400, label: "a" },
        { type: "output" as const, x: 500, y: 400, label: "t" },
      ],
    ],
  ])("draws %s as a frame fitted round its members", (id, members) => {
    const frame = frameOf(toViewNodes(containersOnCanvas(), [], {}, null), id);

    expect(frame).toMatchObject({
      type: "container-frame",
      ...enclosing(members),
      data: expect.objectContaining({ containerId: id }),
    });
  });

  it("draws each container's frame behind its members", () => {
    const view = toViewNodes(containersOnCanvas(), [], {}, null);
    const indexOf = (id: string) => view.findIndex((node) => node.id === id);

    for (const container of containersOnCanvas().containers) {
      const frame = indexOf(`container-frame-${container.id}`);
      expect(frame).toBeGreaterThanOrEqual(0);
      for (const member of container.nodes) expect(frame).toBeLessThan(indexOf(member));
    }
  });

  it("draws a container's frame behind a Loop frame inside it", () => {
    const source = flow(
      [
        placedAt(trigger("s"), 0, 0),
        placedAt(loop("L"), 200, 0),
        placedAt(agent("p", { parent: "L" }), 200, 100),
        placedAt(output("t"), 600, 0),
      ],
      [],
      flowSettings,
      { containers: [sessionContainer(["s", "L", "t"])] },
    );
    const ids = toViewNodes(source, [], {}, null).map((node) => node.id);

    expect(ids.indexOf("container-frame-session-1")).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf("container-frame-session-1")).toBeLessThan(ids.indexOf("loop-frame-L"));
  });

  it("marks a selected container's frame selected, and only that one", () => {
    const view = toViewNodes(containersOnCanvas(), ["session-2"], {}, null);

    expect(
      ["workspace-1", "session-1", "session-2"].map((id) => frameOf(view, id)?.selected),
    ).toEqual([false, false, true]);
  });

  it("greys only what no container's own Start reaches", () => {
    expect(ignoredOf(containersOnCanvas()).filter(([, ignored]) => ignored === true)).toEqual([
      ["loose", true],
    ]);
  });
});

describe("toViewNodes delete lock", () => {
  it("lets a hard stop be deleted like any node", () => {
    const [node] = nodeViews(inOneSession([hardstop("H")], []), [], {}, null);

    expect(node).not.toHaveProperty("deletable");
  });

  it("adds no deletable field to any other type", () => {
    const source = inOneSession(
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

    const nodes = nodeViews(source, [], {}, null).filter((node) => node.type !== "loop-frame");

    expect(nodes.map((node) => node.id)).toEqual(["T", "P", "S", "G", "K", "Q", "L", "O"]);
    for (const node of nodes) expect(node).not.toHaveProperty("deletable");
  });
});

describe("toViewNodes with a branch", () => {
  const branchData = () => {
    const source = inOneSession(
      [{ ...branch("B", "e2e"), settings: { variable: "e2e" }, label: "E2E?" }],
      [],
    );
    return nodeViews(source, [], {}, null).find((node) => node.id === "B")?.data;
  };

  it("sub-lines the branch with the yes/no variable it follows", () => {
    expect(branchData()).toEqual({
      label: "E2E?",
      highlighted: false,
      ignored: false,
      sub: "e2e",
    });
  });

  it("adds no sub to any other type", () => {
    const source = inOneSession(
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

    const others = nodeViews(source, [], {}, null).filter((node) => node.id !== "B");

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
    const source = inOneSession(
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
    expect(toViewEdges(inOneSession([agent("A")], []))).toEqual([]);
  });

  it("ends every wire in a closed arrowhead", () => {
    const source = inOneSession(
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
    const source = inOneSession(
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
    const source = inOneSession(
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
    const source = inOneSession(
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
    const wires = inOneSession(
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
  inOneSession(
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
    const view = nodeViews(parallelSection(), [], {}, null);

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
    const view = nodeViews(parallelSection(), [], { F: { x: 40, y: 500 } }, null);

    expect(viewOf(view, "F")).toMatchObject({ position: { x: 40, y: 10 }, height: 208 });
  });

  it("gives a fork with no wires its look box at its stored position", () => {
    const [node] = nodeViews(
      inOneSession([{ ...fork("F"), position: { x: 30, y: 60 } }], []),
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
    const [node] = nodeViews(inOneSession([join("J")], []), [], {}, null);

    expect(node).toMatchObject({ id: "J", width: 28, height: BAR_MIN_HEIGHT });
  });

  it("keeps a bar over branches shorter than its tag at the minimum height", () => {
    const view = nodeViews(
      inOneSession(
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
  inOneSession(
    [
      { ...fork("F"), position: { x: 10, y: 10 } },
      { ...join("J"), position: { x: 270, y: joinY } },
    ],
    [thenWire("F", "J")],
  );

const directWireAndBox = () =>
  inOneSession(
    [
      { ...fork("F"), position: { x: 10, y: 10 } },
      { ...agent("b1"), position: { x: 70, y: 90 } },
      { ...join("J"), position: { x: 270, y: 0 } },
    ],
    [thenWire("F", "J"), thenWire("F", "b1")],
  );

describe("toViewNodes with a fork wired straight to a join", () => {
  it("draws each bar at its own stored position with its own look box", () => {
    const view = nodeViews(directWire(), [], {}, null);

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
    const view = nodeViews(directWire(), [], { F: { x: 40, y: 500 } }, null);

    expect(viewOf(view, "F")).toMatchObject({ position: { x: 40, y: 500 } });
    expect(viewOf(view, "J")).toMatchObject({ position: { x: 270, y: 300 } });
  });

  it("follows a dragged join the same way", () => {
    const view = nodeViews(directWire(), [], { J: { x: 270, y: -150 } }, null);

    expect(viewOf(view, "J")).toMatchObject({ position: { x: 270, y: -150 } });
    expect(viewOf(view, "F")).toMatchObject({ position: { x: 10, y: 10 } });
  });

  it("still stretches a fork over a box it is also wired to", () => {
    const view = nodeViews(directWireAndBox(), [], {}, null);

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
    nodeViews(inOneSession([node], []), [], {}, null).find((view) => view.id === node.id)?.data
      .label;

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
    const source = inOneSession(
      [loop("L", { settings: { cap: 5 } }), forEach("E", { file: "plan.md" }), agent("A")],
      [],
    );
    const data = Object.fromEntries(
      nodeViews(source, [], {}, null).map((node) => [node.id, node.data]),
    );

    expect(data["L"]?.sub).toBe("max 5");
    expect(data["E"]?.sub).toBe("plan.md");
    expect(data["A"]).not.toHaveProperty("sub");
  });

  it("widens a frame so a long Loop label stays inside it", () => {
    const frameWidth = (label: string) =>
      nodeViews(inOneSession([{ ...loop("L"), label }], []), [], {}, null).find(
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
        nodeViews(
          inOneSession(
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
    const view = nodeViews(wide, [], {}, null);

    expect(viewOf(view, "F")?.width).toBe(28);
    expect(viewOf(view, "J")?.width).toBe(28);
  });
});

describe("toViewNodes while a container is dragged", () => {
  const dragged = () =>
    inOneSession(
      [
        { ...loop("L"), position: { x: 0, y: 0 } },
        { ...agent("X", { parent: "L" }), position: { x: 0, y: 100 } },
        { ...agent("A"), position: { x: 600, y: 0 } },
      ],
      [],
    );

  it("moves the body and the frame with the container's live drag", () => {
    const nodes = nodeViews(dragged(), [], { L: { x: 50, y: 20 } }, null);
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
    const nodes = nodeViews(dragged(), [], { L: { x: 50, y: 20 }, X: { x: 300, y: 300 } }, null);

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

describe("toViewEdges with connections", () => {
  const connected = (): Flow => ({
    ...flow(
      [
        trigger("w-start"),
        output("w-stop"),
        trigger("a1"),
        output("a2"),
        trigger("i1"),
        output("i2"),
      ],
      [thenWire("w-start", "w-stop"), thenWire("a1", "a2"), thenWire("i1", "i2")],
      flowSettings,
      {
        containers: [
          workspaceContainer(["w-start", "w-stop"]),
          sessionContainer(["a1", "a2"], { id: "android", name: "android" }),
          sessionContainer(["i1", "i2"], { id: "ios", name: "ios" }),
          sessionContainer([], { id: "web", name: "web" }),
        ],
      },
    ),
    connections: [
      { id: "c1", between: ["android", "ios"] },
      { id: "c2", between: ["ios", "web"] },
    ],
  });

  const connectionEdges = (source: Flow) =>
    toViewEdges(source).filter((edge) => edge.type === "connection");

  it("draws one dashed connection edge with a head at each end between the two frames", () => {
    const [edge, ...rest] = connectionEdges(connected());

    expect(rest).toEqual([]);
    expect(edge).toMatchObject({
      id: "connection-c1",
      type: "connection",
      source: "container-frame-android",
      sourceHandle: connectionPorts.source,
      target: "container-frame-ios",
      targetHandle: connectionPorts.target,
      markerStart: { type: MarkerType.ArrowClosed },
      markerEnd: { type: MarkerType.ArrowClosed },
      style: { strokeDasharray: expect.any(String) },
    });
  });

  it("draws no connection edge to a container whose frame is not drawn", () => {
    expect(connectionEdges(connected()).map(({ id }) => id)).not.toContain("connection-c2");
  });

  it("gives no other edge a dash array", () => {
    const others = toViewEdges(connected()).filter((edge) => edge.type !== "connection");

    expect(others).toHaveLength(3);
    for (const edge of others) expect(edge.style?.strokeDasharray).toBeUndefined();
  });
});

describe("toViewNodes and container frames on the canvas path", () => {
  const twoSessions = (): Flow =>
    throughSession(
      parseFlow({
        nodes: [trigger("s"), output("t"), trigger("u"), output("v")],
        wires: [thenWire("s", "t"), thenWire("u", "v")],
        settings: flowSettings,
        containers: [
          sessionContainer(["s", "t"]),
          sessionContainer(["u", "v"], { id: "session-2", name: "web" }),
        ],
      }),
    );

  const frameIgnored = (source: Flow) =>
    toViewNodes(source, [], {}, null)
      .filter((node) => node.type === "container-frame")
      .map((node) => [node.data.containerId, node.data.ignored]);

  it("greys the frame of a session the canvas path does not reach, and only that one", () => {
    expect(frameIgnored(twoSessions())).toEqual([
      ["session-1", false],
      ["session-2", true],
    ]);
  });

  it("greys the members of a session the canvas path does not reach", () => {
    expect(ignoredOf(twoSessions()).filter(([, ignored]) => ignored === true)).toEqual([
      ["u", true],
      ["v", true],
    ]);
  });

  it("greys no frame in a workflow, whose workspace reaches every session", () => {
    expect(frameIgnored(containersOnCanvas())).toEqual([
      ["workspace-1", false],
      ["session-1", false],
      ["session-2", false],
    ]);
  });

  it("greys no frame when there is no canvas Start", () => {
    const { nodes, wires, ...rest } = twoSessions();
    const noStart = parseFlow({
      ...rest,
      nodes: nodes.filter((node) => node.id !== "canvas-start"),
      wires: wires.filter((each) => each.from.node !== "canvas-start"),
    });

    expect(frameIgnored(noStart)).toEqual([
      ["session-1", false],
      ["session-2", false],
    ]);
  });
});

describe("toViewEdges with container ends", () => {
  const source = () =>
    throughSession(inOneSession([trigger("s"), output("t")], [thenWire("s", "t")]));

  const edgeFrom = (node: string) =>
    toViewEdges(source()).find((edge) => edge.id.startsWith(`${node}:`));

  it("ends a wire into a container on its frame's flow-in handle", () => {
    expect(edgeFrom("canvas-start")).toMatchObject({
      id: `canvas-start:out->session-1:${flowIn}`,
      source: "canvas-start",
      sourceHandle: "out",
      target: "container-frame-session-1",
      targetHandle: flowIn,
    });
  });

  it("starts a wire out of a container on its frame's flow-out handle", () => {
    expect(edgeFrom("session-1")).toMatchObject({
      id: `session-1:${flowOut}->canvas-stop:in`,
      source: "container-frame-session-1",
      sourceHandle: flowOut,
      target: "canvas-stop",
      targetHandle: "in",
    });
  });

  it("draws a container wire as a plain wire, not a dashed connection", () => {
    const edge = edgeFrom("session-1");

    expect(edge?.type).toBeUndefined();
    expect(edge?.style).toBeUndefined();
  });
});

describe("routeConnection", () => {
  const drag = (
    source: string,
    sourceHandle: string | null,
    target: string,
    targetHandle: string | null,
  ) => ({ source, sourceHandle, target, targetHandle });

  it("connects two sessions when the drag runs between their connection handles", () => {
    expect(
      routeConnection(
        drag(
          "container-frame-android",
          connectionPorts.source,
          "container-frame-ios",
          connectionPorts.target,
        ),
      ),
    ).toEqual({ kind: "sessions", from: "android", to: "ios" });
  });

  it("wires two frames when the drag runs from a flow-out to a flow-in", () => {
    expect(
      routeConnection(drag("container-frame-android", flowOut, "container-frame-ios", flowIn)),
    ).toEqual({
      kind: "wire",
      from: { node: "android", port: flowOut },
      to: { node: "ios", port: flowIn },
    });
  });

  it.each([
    [
      "a node to a frame",
      drag("start", "out", "container-frame-workspace-1", flowIn),
      "start",
      "workspace-1",
    ],
    [
      "a frame to a node",
      drag("container-frame-workspace-1", flowOut, "stop", "in"),
      "workspace-1",
      "stop",
    ],
    ["two nodes", drag("a", "out", "b", "in"), "a", "b"],
  ])("wires %s, naming a frame by its container", (_name, connection, from, to) => {
    expect(routeConnection(connection)).toEqual({
      kind: "wire",
      from: { node: from, port: connection.sourceHandle },
      to: { node: to, port: connection.targetHandle },
    });
  });

  it("routes nothing when a handle is missing", () => {
    expect(routeConnection(drag("a", null, "b", "in"))).toBeNull();
    expect(routeConnection(drag("a", "out", "b", null))).toBeNull();
  });
});

describe("frameOwnerId", () => {
  it.each([
    ["container-frame-session-1", "session-1"],
    ["container-frame-workspace-1", "workspace-1"],
    ["loop-frame-L", "L"],
    ["foreach-frame-F", "F"],
  ])("maps %s to %s", (viewId, owner) => {
    expect(frameOwnerId(viewId)).toBe(owner);
  });

  it.each(["P", "loop-1", "foreach-1", "agent-1"])("gives nothing for the plain id %s", (id) => {
    expect(frameOwnerId(id)).toBeUndefined();
  });

  it("names the same owner as every frame's data", () => {
    const base = containersOnCanvas();
    const source = parseFlow({
      ...base,
      nodes: [
        ...base.nodes,
        placedAt(loop("L"), 1000, 0),
        placedAt(agent("P", { parent: "L" }), 1000, 80),
        placedAt(forEach("F"), 1400, 0),
        placedAt(agent("Q", { parent: "F" }), 1400, 80),
      ],
    });
    const ownerKey = {
      "container-frame": "containerId",
      "loop-frame": "loopId",
      "foreach-frame": "forEachId",
    } as const;
    const checked = new Set<string>();

    for (const node of toViewNodes(source, [], {}, null)) {
      const key: string | undefined = ownerKey[node.type as keyof typeof ownerKey];
      if (key === undefined) continue;
      expect(frameOwnerId(node.id)).toBe((node.data as Record<string, unknown>)[key]);
      checked.add(key);
    }

    expect([...checked].sort()).toEqual(["containerId", "forEachId", "loopId"]);
  });
});
