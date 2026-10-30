import { describe, expect, it } from "vitest";
import {
  edgeId,
  FRAME_PADDING,
  SESSION_FRAME_ID,
  toViewEdges,
  toViewNodes,
} from "../../../../src/app/renderer/canvas/view.js";
import { nodeLook } from "../../../../src/app/renderer/nodes/look.js";
import type { Flow, NodeType, Wire } from "../../../../src/core/flow/schema.js";
import {
  agent,
  ask,
  flow,
  gate,
  hardstop,
  loop,
  output,
  prompt,
  script,
  thenWire,
  trigger,
  wire,
} from "../../../fixtures/flow-builders.js";

const twoNodes = () =>
  flow(
    [
      { ...prompt("prompt-1"), label: "Prompt", position: { x: 120, y: 80 } },
      { ...script("script-1"), label: "Script", position: { x: 300, y: 40 } },
    ],
    [thenWire("prompt-1", "script-1")],
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
        id: "prompt-1",
        type: "prompt",
        position: { x: 120, y: 80 },
        selected: false,
        data: { label: "Prompt", highlighted: false },
      },
      {
        id: "script-1",
        type: "script",
        position: { x: 300, y: 40 },
        selected: false,
        data: { label: "Script", highlighted: false },
      },
    ]);
  });

  it("marks selected only the nodes whose ids are in the selection", () => {
    const view = toViewNodes(twoNodes(), ["script-1"], {}, null);

    expect(view.map((node) => [node.id, node.selected])).toEqual([
      ["prompt-1", false],
      ["script-1", true],
    ]);
  });

  it("ignores selection ids that are not in the flow", () => {
    const view = toViewNodes(twoNodes(), ["gone-1"], {}, null);

    expect(view.map((node) => node.selected)).toEqual([false, false]);
  });

  it("takes the drag position when one is held, else the flow position", () => {
    const view = toViewNodes(twoNodes(), [], { "prompt-1": { x: 500, y: 600 } }, null);

    expect(view.map((node) => [node.id, node.position])).toEqual([
      ["prompt-1", { x: 500, y: 600 }],
      ["script-1", { x: 300, y: 40 }],
    ]);
  });

  it("marks highlighted only the node whose id is given, without selecting any node", () => {
    const view = toViewNodes(twoNodes(), [], {}, "script-1");

    expect(view.map((node) => [node.id, node.data.highlighted, node.selected])).toEqual([
      ["prompt-1", false, false],
      ["script-1", true, false],
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

const framed = (source: Flow, nodes: string[]): Flow => ({
  ...source,
  session: { ...source.session, name: "build", frame: { nodes } },
});

const threeApart = () =>
  flow(
    [
      { ...prompt("A"), position: { x: 100, y: 50 } },
      { ...script("B"), position: { x: 400, y: 300 } },
      { ...prompt("C"), position: { x: 900, y: 900 } },
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

describe("toViewNodes with a session frame", () => {
  it("emits no frame view-node when the session has no frame", () => {
    expect(toViewNodes(threeApart(), [], {}, null).map((node) => node.id)).toEqual(["A", "B", "C"]);
  });

  it("emits the frame first, fixed in place, enclosing only its members with padding", () => {
    const source = framed(threeApart(), ["A", "B"]);

    const [frame, ...rest] = toViewNodes(source, [], {}, null);

    expect(frame).toMatchObject({
      id: SESSION_FRAME_ID,
      type: "session",
      selectable: false,
      draggable: false,
      deletable: false,
      data: { name: "build" },
      ...enclosing([
        { type: "prompt", x: 100, y: 50 },
        { type: "script", x: 400, y: 300 },
      ]),
    });
    expect(rest).toEqual(toViewNodes(threeApart(), [], {}, null));
    expect(rest.some((node) => "parentId" in node)).toBe(false);
  });

  it("encloses a member loop's frame plus padding, so the two frames share no edge", () => {
    const source = framed(
      flow(
        [
          { ...loop("L"), position: { x: 0, y: 0 } },
          { ...prompt("X", { parent: "L" }), position: { x: 500, y: 400 } },
        ],
        [],
      ),
      ["L"],
    );

    const [frame] = toViewNodes(source, [], {}, null);

    expect(frame).toMatchObject({
      id: SESSION_FRAME_ID,
      ...grown([
        enclosing([
          { type: "loop", x: 0, y: 0 },
          { type: "prompt", x: 500, y: 400 },
        ]),
      ]),
    });
  });

  it("encloses a member loop's frame together with the other members", () => {
    const source = framed(
      flow(
        [
          { ...loop("L"), position: { x: 0, y: 0 } },
          { ...prompt("X", { parent: "L" }), position: { x: 300, y: 200 } },
          { ...script("A"), position: { x: 700, y: -100 } },
        ],
        [],
      ),
      ["L", "A"],
    );

    const [frame] = toViewNodes(source, [], {}, null);

    expect(frame).toMatchObject({
      id: SESSION_FRAME_ID,
      ...grown([
        enclosing([
          { type: "loop", x: 0, y: 0 },
          { type: "prompt", x: 300, y: 200 },
        ]),
        boxOf("script", 700, -100),
      ]),
    });
  });

  it("takes an ask member's taller box for its bottom edge", () => {
    const source = framed(
      flow(
        [
          { ...prompt("A"), position: { x: 0, y: 100 } },
          { ...ask("Q"), position: { x: 300, y: 100 } },
        ],
        [],
      ),
      ["A", "Q"],
    );

    const [frame] = toViewNodes(source, [], {}, null);

    expect(frame).toMatchObject({
      id: SESSION_FRAME_ID,
      position: { x: -FRAME_PADDING, y: 100 - FRAME_PADDING },
      height: 57 + 2 * FRAME_PADDING,
    });
  });

  it("ignores member ids that name no node", () => {
    const [frame] = toViewNodes(framed(threeApart(), ["ghost", "A"]), [], {}, null);

    expect(frame).toMatchObject({
      id: SESSION_FRAME_ID,
      ...enclosing([{ type: "prompt", x: 100, y: 50 }]),
    });
  });

  it("emits no frame view-node when no member names a node", () => {
    const view = toViewNodes(framed(threeApart(), ["ghost"]), [], {}, null);

    expect(view).toEqual(toViewNodes(threeApart(), [], {}, null));
  });
});

const loopFrameFlags = {
  type: "loop-frame",
  selectable: false,
  deletable: false,
  draggable: false,
};

describe("toViewNodes with a loop", () => {
  const loopWithBody = () =>
    flow(
      [
        { ...loop("L"), position: { x: 0, y: 0 } },
        { ...prompt("X", { parent: "L" }), position: { x: 500, y: 400 } },
        { ...script("Y", { parent: "L" }), position: { x: 200, y: 100 } },
        { ...prompt("A"), position: { x: 900, y: 900 } },
      ],
      [],
    );

  it("emits a fixed frame enclosing the loop's own box and its body, with padding", () => {
    const frame = toViewNodes(loopWithBody(), [], {}, null).find(
      (node) => node.id === "loop-frame-L",
    );

    expect(frame).toMatchObject({
      id: "loop-frame-L",
      ...loopFrameFlags,
      ...enclosing([
        { type: "loop", x: 0, y: 0 },
        { type: "prompt", x: 500, y: 400 },
        { type: "script", x: 200, y: 100 },
      ]),
    });
  });

  it("emits a frame around the loop's own box when the loop has no body", () => {
    const source = flow([{ ...loop("E"), position: { x: 40, y: 60 } }], []);

    const frame = toViewNodes(source, [], {}, null).find((node) => node.id === "loop-frame-E");

    expect(frame).toMatchObject({
      id: "loop-frame-E",
      ...loopFrameFlags,
      ...enclosing([{ type: "loop", x: 40, y: 60 }]),
    });
  });

  it("puts loop frames before every flow node, so they stack behind them", () => {
    const source = flow(
      [
        { ...loop("L"), position: { x: 0, y: 0 } },
        { ...prompt("X", { parent: "L" }), position: { x: 200, y: 0 } },
        { ...loop("M"), position: { x: 0, y: 400 } },
      ],
      [],
    );

    expect(toViewNodes(source, [], {}, null).map((node) => node.id)).toEqual([
      "loop-frame-L",
      "loop-frame-M",
      "L",
      "X",
      "M",
    ]);
  });

  it("puts loop frames after the session frame and before the flow nodes", () => {
    const source = framed(loopWithBody(), ["L"]);

    expect(toViewNodes(source, [], {}, null).map((node) => node.id)).toEqual([
      SESSION_FRAME_ID,
      "loop-frame-L",
      "L",
      "X",
      "Y",
      "A",
    ]);
  });
});

describe("toViewNodes delete lock", () => {
  it("marks a hard stop view node not deletable", () => {
    const [node] = toViewNodes(flow([hardstop("H")], []), [], {}, null);

    expect(node).toMatchObject({ id: "H", type: "hardstop", deletable: false });
  });

  it("adds no deletable field to any other type", () => {
    const source = flow(
      [
        trigger("T"),
        prompt("P"),
        script("S"),
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

describe("toViewEdges", () => {
  it("maps each wire to its id and its source and target nodes and handles", () => {
    expect(toViewEdges(twoNodes())).toEqual([
      {
        id: "prompt-1:out->script-1:in",
        source: "prompt-1",
        sourceHandle: "out",
        target: "script-1",
        targetHandle: "in",
      },
    ]);
  });

  it("keeps one entry per wire in flow order", () => {
    const source = flow(
      [prompt("A"), prompt("B"), script("C")],
      [thenWire("A", "B"), thenWire("B", "C"), thenWire("A", "C")],
    );

    expect(toViewEdges(source).map((edge) => edge.id)).toEqual([
      "A:out->B:in",
      "B:out->C:in",
      "A:out->C:in",
    ]);
  });

  it("returns no entries for a flow without wires", () => {
    expect(toViewEdges(flow([prompt("A")], []))).toEqual([]);
  });
});

describe("edgeId", () => {
  it("is built from both endpoints as from.node:from.port->to.node:to.port", () => {
    expect(edgeId(thenBetween("prompt-1", "out", "script-1", "in"))).toBe(
      "prompt-1:out->script-1:in",
    );
  });

  it("gives different wires different ids", () => {
    const wires = flow(
      [prompt("A"), prompt("B"), prompt("C")],
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
