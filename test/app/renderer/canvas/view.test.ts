import { describe, expect, it } from "vitest";
import {
  edgeId,
  FRAME_PADDING,
  NODE_BOX,
  SESSION_FRAME_ID,
  toViewEdges,
  toViewNodes,
} from "../../../../src/app/renderer/canvas/view.js";
import type { Flow, Wire } from "../../../../src/core/flow/schema.js";
import { flow, loop, prompt, script, thenWire, wire } from "../../../fixtures/flow-builders.js";

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

const enclosing = (positions: { x: number; y: number }[]) => {
  const left = Math.min(...positions.map((p) => p.x)) - FRAME_PADDING;
  const top = Math.min(...positions.map((p) => p.y)) - FRAME_PADDING;
  const right = Math.max(...positions.map((p) => p.x)) + NODE_BOX.width + FRAME_PADDING;
  const bottom = Math.max(...positions.map((p) => p.y)) + NODE_BOX.height + FRAME_PADDING;
  return { position: { x: left, y: top }, width: right - left, height: bottom - top };
};

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
        { x: 100, y: 50 },
        { x: 400, y: 300 },
      ]),
    });
    expect(rest).toEqual(toViewNodes(threeApart(), [], {}, null));
    expect(rest.some((node) => "parentId" in node)).toBe(false);
  });

  it("encloses the body of a loop that is a member", () => {
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
      ...enclosing([
        { x: 0, y: 0 },
        { x: 500, y: 400 },
      ]),
    });
  });

  it("ignores member ids that name no node", () => {
    const [frame] = toViewNodes(framed(threeApart(), ["ghost", "A"]), [], {}, null);

    expect(frame).toMatchObject({ id: SESSION_FRAME_ID, ...enclosing([{ x: 100, y: 50 }]) });
  });

  it("emits no frame view-node when no member names a node", () => {
    const view = toViewNodes(framed(threeApart(), ["ghost"]), [], {}, null);

    expect(view).toEqual(toViewNodes(threeApart(), [], {}, null));
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
