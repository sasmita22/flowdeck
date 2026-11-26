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
  type ViewEdge,
} from "../../../../src/app/renderer/canvas/view.js";
import {
  bodyFrameBounds,
  containerText,
  flowContainerBounds,
  sideLabelSpan,
  type Bounds,
} from "../../../../src/app/renderer/canvas/frames.js";
import { labelPoint } from "../../../../src/app/renderer/canvas/wire-route.js";
import { bezierCrosses, type ExitSide } from "../../../../src/core/flow/wire-router.js";
import { BAR_MIN_HEIGHT, nodeLook } from "../../../../src/app/renderer/nodes/look.js";
import {
  parseFlow,
  type Flow,
  type NodeType,
  type Wire,
} from "../../../../src/core/flow/schema.js";
import type { LibraryLookup } from "../../../../src/core/flow/libraries.js";
import { flowContainerOf, flowIn, flowOut } from "../../../../src/core/flow/structure.js";
import { featureLibrary, wrappedFeatureLibrary } from "../../../fixtures/feature-library.js";
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
import { libraryOf } from "../../../fixtures/known-library.js";
import {
  box,
  canvas,
  drawnBoxes,
  obstaclesFor,
  overlaps,
  pathCrossings,
  routeShapeProblems,
  rowsSpanned,
  tidied,
  type Point,
} from "./canvas-geometry.js";

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

const ignoredOf = (source: Flow, libraries?: LibraryLookup) =>
  nodeViews(source, [], {}, null, {}, libraries).map((node) => [node.id, node.data.ignored]);

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

  const libraryNode = (id: string, libraryId: string) => ({
    id,
    type: "library",
    label: id,
    position: { x: 0, y: 1200 },
    settings: { libraryId, label: id, overrides: {} },
  });

  const libraries = libraryOf({ nodes: "node-library", sessions: "session-library" });

  const workflowWithLoose = (): Flow =>
    flow(
      [
        trigger("w-start"),
        output("w-stop"),
        agent("loose-agent"),
        libraryNode("nodes-use", "nodes"),
        libraryNode("sessions-use", "sessions"),
      ],
      [thenWire("w-start", "w-stop")],
      flowSettings,
      { containers: [workspaceContainer(["w-start", "w-stop"])] },
    );

  it.each([
    ["a loose Agent", "loose-agent", true],
    ["a loose node library", "nodes-use", true],
    ["a loose session library", "sessions-use", false],
  ])("greys %s in a workflow by its library kind", (_, id, ignored) => {
    expect(ignoredOf(workflowWithLoose(), libraries).find(([nodeId]) => nodeId === id)).toEqual([
      id,
      ignored,
    ]);
  });

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

describe("toViewEdges routes wires that leave their row", () => {
  const widths = [1600, 1400, 860];

  const tidiedAt = (width: number) => tidied(featureLibrary, { ...canvas, width });

  const labelledBoxes = (current: Flow): Map<string, Bounds> => {
    const boxes = drawnBoxes(current);
    for (const node of current.nodes) {
      const drawn = boxes.get(node.id);
      if (drawn !== undefined && (node.type === "trigger" || node.type === "output"))
        boxes.set(node.id, { ...drawn, right: drawn.right + sideLabelSpan(node.label) });
    }
    return boxes;
  };

  const typeOf = (current: Flow, id: string) => current.nodes.find((node) => node.id === id)?.type;

  const handles = (current: Flow, boxes: Map<string, Bounds>, wire: Wire) => {
    const from = box(boxes, wire.from.node);
    const to = box(boxes, wire.to.node);
    const target = { x: to.left, y: to.top + 24 };
    if (typeOf(current, wire.from.node) === "branch" && wire.from.port === "no")
      return {
        source: { x: (from.left + from.right) / 2, y: from.bottom },
        side: "bottom" as ExitSide,
        target,
      };
    if (typeOf(current, wire.from.node) === "branch")
      return {
        source: { x: from.right, y: (from.top + from.bottom) / 2 },
        side: "right" as ExitSide,
        target,
      };
    return { source: { x: from.right, y: from.top + 24 }, side: "right" as ExitSide, target };
  };

  const crossesToday = (current: Flow, boxes: Map<string, Bounds>, wire: Wire) => {
    const { source, side, target } = handles(current, boxes, wire);
    return bezierCrosses(source, side, target, obstaclesFor(boxes, wire.from.node, wire.to.node));
  };

  const inFrame = (current: Flow, wire: Wire) => {
    const ids = new Set(current.nodes.map(({ id }) => id));
    const from = flowContainerOf(current, wire.from.node);
    return (
      wire.kind === "then" &&
      ids.has(wire.from.node) &&
      ids.has(wire.to.node) &&
      from !== undefined &&
      from.id === flowContainerOf(current, wire.to.node)?.id
    );
  };

  const leavesRow = (from: Bounds, to: Bounds) =>
    !(from.top < to.bottom && to.top < from.bottom) || to.left < from.right;

  const pointsOf = (edge: ViewEdge | undefined): Point[] | undefined =>
    edge?.data !== undefined && "points" in edge.data ? edge.data.points : undefined;

  const routedFrom = (edges: readonly ViewEdge[], source: string, target: string) =>
    edges.find((edge) => edge.source === source && edge.target === target);

  const within = (current: Flow, id: string, scope: string): boolean => {
    const parent = current.nodes.find((node) => node.id === id)?.parent;
    return id === scope || (parent !== undefined && within(current, parent, scope));
  };

  const foreignBodies = (current: Flow, source: string, target: string): Bounds[] =>
    current.nodes
      .filter((node) => node.type === "loop" || node.type === "foreach")
      .filter((scope) => !within(current, source, scope.id) && !within(current, target, scope.id))
      .map((scope) => bodyFrameBounds(current, scope));

  const frameOf = (current: Flow, id: string): Bounds => {
    const container = flowContainerOf(current, id);
    if (container === undefined) throw new Error(`${id} is in no frame`);
    return flowContainerBounds(current, container.id);
  };

  const labelGap = 4;

  const wireLabelBox = (label: string, at: Point): Bounds => {
    const width = label.length * 0.6 * 9.5 + 2 * (5 + 1);
    const height = 13 + 2;
    return {
      left: at.x - width / 2,
      top: at.y - height / 2,
      right: at.x + width / 2,
      bottom: at.y + height / 2,
    };
  };

  const portLabelBox = (from: Bounds, port: string): Bounds => {
    const width = port.length * 0.6 * 9.5;
    if (port === "no") {
      const x = (from.left + from.right) / 2 - 3 + 8;
      return { left: x, top: from.bottom + 3, right: x + width, bottom: from.bottom + 3 + 13 };
    }
    const y = (from.top + from.bottom) / 2;
    return { left: from.right + 3, top: y - 17, right: from.right + 3 + width, bottom: y - 4 };
  };

  const gapBetween = (a: Bounds, b: Bounds) =>
    Math.hypot(
      Math.max(0, a.left - b.right, b.left - a.right),
      Math.max(0, a.top - b.bottom, b.top - a.bottom),
    );

  const labelProblems = (boxes: Map<string, Bounds>, edge: ViewEdge): string[] => {
    const label = edge.sourceHandle ?? "";
    const from = box(boxes, edge.source);
    const at = labelPoint(pointsOf(edge) ?? []);
    const drawn = wireLabelBox(label, at);
    const width = drawn.right - drawn.left;
    const fromNode = gapBetween({ left: at.x, top: at.y, right: at.x, bottom: at.y }, from);
    return [
      ...(fromNode >= width / 2 + labelGap
        ? []
        : [
            `${edge.id}: label point is ${fromNode} px from its node, needs ${width / 2 + labelGap}`,
          ]),
      ...(gapBetween(drawn, portLabelBox(from, label)) >= labelGap
        ? []
        : [`${edge.id}: label overlaps the port label`]),
    ];
  };

  it.each(widths)(
    "routes every in-frame wire that goes back or leaves its row over a node, around the nodes, at %i px",
    async (width) => {
      const current = await tidiedAt(width);
      const boxes = labelledBoxes(current);
      const edges = toViewEdges(current);
      const routed = edges.filter((edge) => edge.type === "routed");

      expect(routedFrom(routed, "n2", "stop")).toBeDefined();
      expect(
        routed.some(({ source, target }) => {
          const from = box(boxes, source);
          const to = box(boxes, target);
          return to.top >= from.bottom && to.left < from.left;
        }),
      ).toBe(true);
      const problems = routed.flatMap((edge) => {
        const wire = current.wires.find((candidate) => edgeId(candidate) === edge.id);
        if (wire === undefined) return [`${edge.id}: no wire with this id`];
        const points = pointsOf(edge) ?? [];
        const side = edge.sourceHandle === "no" ? "bottom" : "right";
        return [
          ...routeShapeProblems(points, side),
          ...pathCrossings(points, obstaclesFor(boxes, edge.source, edge.target)).map(
            (crossed) => `crosses ${JSON.stringify(crossed)}`,
          ),
          ...rowsSpanned(
            points,
            obstaclesFor(boxes, edge.source, edge.target).filter((row) =>
              overlaps(row, frameOf(current, edge.source)),
            ),
            frameOf(current, edge.source),
          ),
          ...pathCrossings(points, foreignBodies(current, edge.source, edge.target)).map(
            (entered) => `enters the body frame ${JSON.stringify(entered)}`,
          ),
        ].map((problem) => `${edge.id}: ${problem}`);
      });
      expect(problems).toEqual([]);
      const byId = new Map(edges.map((edge) => [edge.id, edge]));
      const missed = current.wires
        .filter((wire) => inFrame(current, wire))
        .filter((wire) => leavesRow(box(boxes, wire.from.node), box(boxes, wire.to.node)))
        .filter((wire) => crossesToday(current, boxes, wire))
        .map(edgeId)
        .filter((id) => byId.get(id)?.type !== "routed");
      expect(missed).toEqual([]);
      const backward = current.wires
        .filter((wire) => inFrame(current, wire))
        .filter((wire) => box(boxes, wire.to.node).left < box(boxes, wire.from.node).right)
        .map(edgeId);
      expect(backward.length).toBeGreaterThan(0);
      expect(backward.filter((id) => byId.get(id)?.type !== "routed")).toEqual([]);
    },
  );

  it("keeps the port label on every routed Branch wire, clear of its node and port label", async () => {
    const current = await tidiedAt(1600);
    const boxes = labelledBoxes(current);
    const routedBranches = toViewEdges(current).filter(
      (edge) => edge.type === "routed" && typeOf(current, edge.source) === "branch",
    );

    expect(routedBranches.length).toBeGreaterThan(0);
    for (const edge of routedBranches)
      expect(edge.data).toMatchObject({ label: edge.sourceHandle });
    expect(routedBranches.flatMap((edge) => labelProblems(boxes, edge))).toEqual([]);
  });

  it("routes a Branch no wire to a node a row above it downwards first, keeping its label", () => {
    const current = inOneSession(
      [
        { ...branch("B", "flag"), position: { x: 300, y: 300 } },
        { ...agent("M"), position: { x: 440, y: 230 } },
        { ...agent("X"), position: { x: 600, y: 150 } },
        { ...agent("Z"), position: { x: 300, y: 520 } },
      ],
      [wire("B", "no", "X", "in")],
    );
    const noWire = current.wires[0];
    if (noWire === undefined) throw new Error("no wire");
    const boxes = labelledBoxes(current);
    expect(crossesToday(current, boxes, noWire)).toBe(true);

    const [edge] = toViewEdges(current);

    expect(edge?.type).toBe("routed");
    expect(edge?.data).toMatchObject({ label: "no" });
    expect(routeShapeProblems(pointsOf(edge) ?? [], "bottom")).toEqual([]);
    expect(edge === undefined ? ["no edge"] : labelProblems(boxes, edge)).toEqual([]);
  });

  it("keeps today's Branch wire when its label stub has no room inside the frame", () => {
    const current = inOneSession(
      [
        { ...branch("B", "flag"), position: { x: 300, y: 300 } },
        { ...agent("M"), position: { x: 440, y: 230 } },
        { ...agent("X"), position: { x: 600, y: 150 } },
      ],
      [wire("B", "no", "X", "in")],
    );
    const noWire = current.wires[0];
    if (noWire === undefined) throw new Error("no wire");
    expect(crossesToday(current, labelledBoxes(current), noWire)).toBe(true);

    expect(toViewEdges(current).map(({ type, data }) => ({ type, data }))).toEqual([
      { type: "branch", data: { label: "no" } },
    ]);
  });

  it.each(widths)(
    "keeps today's edge for every wire to a node further along its row at %i px",
    async (width) => {
      const current = await tidiedAt(width);
      const boxes = labelledBoxes(current);
      const byId = new Map(toViewEdges(current).map((edge) => [edge.id, edge]));
      const forward = current.wires.filter((wire) => {
        if (!inFrame(current, wire)) return false;
        const from = box(boxes, wire.from.node);
        const to = box(boxes, wire.to.node);
        return from.top < to.bottom && to.top < from.bottom && to.left >= from.right;
      });

      expect(forward.length).toBeGreaterThan(0);
      for (const wire of forward) {
        const edge = byId.get(edgeId(wire));
        expect([undefined, "aligned", "branch"]).toContain(edge?.type);
        expect(pointsOf(edge)).toBeUndefined();
      }
    },
  );

  it("keeps today's edge for a wire that skips a node on its own row", () => {
    const current = inOneSession(
      [
        { ...agent("A"), position: { x: 0, y: 0 } },
        { ...agent("B"), position: { x: 250, y: 0 } },
        { ...agent("C"), position: { x: 500, y: 0 } },
      ],
      [thenWire("A", "C")],
    );
    const skip = current.wires[0];
    if (skip === undefined) throw new Error("no wire");
    expect(crossesToday(current, labelledBoxes(current), skip)).toBe(true);

    expect(toViewEdges(current)).toEqual([
      {
        id: "A:out->C:in",
        source: "A",
        sourceHandle: "out",
        target: "C",
        targetHandle: "in",
        markerEnd: { type: MarkerType.ArrowClosed },
      },
    ]);
  });

  it.each([
    { x: 100, y: 40 },
    { x: -60, y: 20 },
  ])("keeps today's edge for a node dragged partly onto its sender at $x,$y", (position) => {
    const current = inOneSession(
      [
        { ...agent("A"), position: { x: 0, y: 0 } },
        { ...agent("B"), position },
      ],
      [thenWire("A", "B")],
    );

    expect(toViewEdges(current)).toEqual([
      {
        id: "A:out->B:in",
        source: "A",
        sourceHandle: "out",
        target: "B",
        targetHandle: "in",
        markerEnd: { type: MarkerType.ArrowClosed },
      },
    ]);
  });

  it("routes past a node that overlaps an end box", () => {
    const current = inOneSession(
      [
        { ...agent("A"), position: { x: 300, y: 100 } },
        { ...agent("B"), position: { x: 280, y: 200 } },
        { ...agent("C"), position: { x: 360, y: 80 } },
      ],
      [thenWire("A", "B")],
    );

    expect(toViewEdges(current)).toMatchObject([{ id: "A:out->B:in", type: "routed" }]);
  });

  it("routes past a Loop body that overlaps an end box", () => {
    const current = inOneSession(
      [
        { ...agent("a"), position: { x: 120, y: 270 } },
        { ...agent("b"), position: { x: 150, y: 210 } },
        { ...loop("L"), position: { x: 190, y: 260 } },
        { ...agent("in", { parent: "L" }), position: { x: 190, y: 350 } },
      ],
      [thenWire("a", "b")],
    );

    expect(toViewEdges(current)).toMatchObject([{ id: "a:out->b:in", type: "routed" }]);
  });

  describe("with a wrapped flow", () => {
    const wrappedWidths = [1600, 1400, 960, 860];

    const wrappedAt = (width: number) => tidied(wrappedFeatureLibrary, { ...canvas, width });

    const containerEnds = (current: Flow, boxes: Map<string, Bounds>, wire: Wire) => {
      const frames = new Set(current.containers.map(({ id }) => id));
      const middle = ({ top, bottom }: Bounds) => (top + bottom) / 2;
      const from = frames.has(wire.from.node)
        ? flowContainerBounds(current, wire.from.node)
        : box(boxes, wire.from.node);
      const to = frames.has(wire.to.node)
        ? flowContainerBounds(current, wire.to.node)
        : box(boxes, wire.to.node);
      return {
        source: { x: from.right, y: frames.has(wire.from.node) ? middle(from) : from.top + 24 },
        target: { x: to.left, y: frames.has(wire.to.node) ? middle(to) : to.top + 24 },
      };
    };

    const gateBoxes = (current: Flow, boxes: Map<string, Bounds>, wire: Wire): Bounds[] => [
      ...[...boxes]
        .filter(([id]) => id !== wire.from.node && id !== wire.to.node)
        .map(([, bounds]) => bounds),
      ...current.nodes
        .filter((node) => node.type === "loop" || node.type === "foreach")
        .map((scope) => bodyFrameBounds(current, scope)),
    ];

    const containerWires = (current: Flow) => {
      const frames = new Set(current.containers.map(({ id }) => id));
      return current.wires.filter(({ from, to }) => frames.has(from.node) || frames.has(to.node));
    };

    it.each(wrappedWidths)(
      "routes every container wire that crosses a node or body around them at %i px",
      async (width) => {
        const current = await wrappedAt(width);
        const boxes = labelledBoxes(current);
        const edges = new Map(toViewEdges(current).map((edge) => [edge.id, edge]));
        const crossingToday = containerWires(current).filter((wire) => {
          const { source, target } = containerEnds(current, boxes, wire);
          return bezierCrosses(source, "right", target, gateBoxes(current, boxes, wire));
        });

        expect(crossingToday.map(edgeId)).toEqual([
          `session-1:${flowOut}->canvas-stop:in`,
          `workspace-1:${flowOut}->session-1:${flowIn}`,
        ]);
        const problems = crossingToday.flatMap((wire) => {
          const edge = edges.get(edgeId(wire));
          if (edge?.type !== "routed") return [`${edgeId(wire)}: not routed`];
          return pathCrossings(pointsOf(edge) ?? [], gateBoxes(current, boxes, wire)).map(
            (crossed) => `${edgeId(wire)}: crosses ${JSON.stringify(crossed)}`,
          );
        });
        expect(problems).toEqual([]);
      },
    );

    it.each(wrappedWidths)(
      "keeps the canvas Start wire to the workspace plain at %i px",
      async (width) => {
        const edge = toViewEdges(await wrappedAt(width)).find(
          ({ id }) => id === `canvas-start:out->workspace-1:${flowIn}`,
        );

        expect(edge).toBeDefined();
        expect(edge?.type).toBeUndefined();
        expect(edge?.data).toBeUndefined();
      },
    );
  });

  it.each(widths)("keeps wires with a container end plain at %i px", async (width) => {
    const ends = toViewEdges(await tidiedAt(width)).filter(({ id }) => id.includes("session-1:"));

    expect(ends.map(({ id }) => id)).toEqual([
      `canvas-start:out->session-1:${flowIn}`,
      `session-1:${flowOut}->canvas-stop:in`,
    ]);
    for (const edge of ends) {
      expect(edge.type).toBeUndefined();
      expect(edge.data).toBeUndefined();
    }
  });

  it("keeps today's edge for a canvas-level wire outside any frame", () => {
    const current = flow(
      [
        { ...agent("A"), position: { x: 0, y: 0 } },
        { ...agent("B"), position: { x: 300, y: 100 } },
        { ...agent("C"), position: { x: 600, y: 200 } },
      ],
      [thenWire("A", "C")],
      flowSettings,
      { containers: [] },
    );
    const across = current.wires[0];
    if (across === undefined) throw new Error("no wire");
    expect(crossesToday(current, labelledBoxes(current), across)).toBe(true);

    const [edge] = toViewEdges(current);

    expect(edge?.type).toBeUndefined();
    expect(edge?.data).toBeUndefined();
  });

  it("keeps a hand-placed Branch fan-out with nothing between as plain Branch wires", () => {
    const current = inOneSession(
      [
        { ...branch("B", "flag"), position: { x: 0, y: 0 } },
        { ...agent("Y"), position: { x: 300, y: -100 } },
        { ...agent("N"), position: { x: 300, y: 150 } },
      ],
      [wire("B", "yes", "Y", "in"), wire("B", "no", "N", "in")],
    );

    expect(toViewEdges(current).map(({ id, type, data }) => ({ id, type, data }))).toEqual([
      { id: "B:yes->Y:in", type: "branch", data: { label: "yes" } },
      { id: "B:no->N:in", type: "branch", data: { label: "no" } },
    ]);
  });

  it("moves a routed wire's end with its target while the target is dragged", async () => {
    const current = await tidiedAt(860);
    const stop = current.nodes.find((node) => node.id === "stop");
    if (stop === undefined) throw new Error("no stop");
    const dragged = { stop: { x: stop.position.x + 8, y: stop.position.y + 6 } };

    const still = routedFrom(toViewEdges(current), "n2", "stop");
    const moving = routedFrom(toViewEdges(current, [], dragged), "n2", "stop");

    expect(moving?.type).toBe("routed");
    const before = pointsOf(still)?.at(-1);
    const after = pointsOf(moving)?.at(-1);
    expect(before).toBeDefined();
    expect(after).toEqual({ x: (before?.x ?? 0) + 8, y: (before?.y ?? 0) + 6 });
  });

  it("routes a hand-placed 100-node flow during a drag well within a frame budget", async () => {
    const count = 100;
    const columns = 10;
    const order = Array.from({ length: count }, (_, index) => (index * 37) % count);
    const current = inOneSession(
      order.map((_, index) => ({
        ...agent(`h${index}`),
        position: {
          x: (index % columns) * 260 + ((index * 13) % 40),
          y: Math.floor(index / columns) * 140 + ((index * 7) % 30),
        },
      })),
      order.slice(1).map((to, index) => thenWire(`h${order[index] ?? 0}`, `h${to}`)),
    );
    const dragged = { h5: { x: 30, y: 40 } };
    expect(
      toViewEdges(current, [], dragged).filter((edge) => edge.type === "routed").length,
    ).toBeGreaterThan(count / 2);

    const tidiedLibrary = await tidiedAt(860);
    const batch = (route: () => unknown) => {
      const started = performance.now();
      for (let run = 0; run < 20; run += 1) route();
      return (performance.now() - started) / 20;
    };
    const ratios = Array.from(
      { length: 9 },
      () =>
        batch(() => toViewEdges(current, [], dragged)) / batch(() => toViewEdges(tidiedLibrary)),
    ).sort((a, b) => a - b);

    expect(ratios[4]).toBeLessThan(13);
  });

  it.each([
    ["feature library", featureLibrary],
    ["wrapped feature library", wrappedFeatureLibrary],
  ])("routes the tidied %s well within a frame budget", async (_name, library) => {
    const current = await tidied(library, { ...canvas, width: 860 });
    toViewEdges(current);

    const started = performance.now();
    for (let run = 0; run < 20; run += 1) toViewEdges(current);

    expect((performance.now() - started) / 20).toBeLessThan(8);
  });
});
