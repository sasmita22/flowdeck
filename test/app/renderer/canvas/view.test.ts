import { describe, expect, it } from "vitest";
import { edgeId, toViewEdges, toViewNodes } from "../../../../src/app/renderer/canvas/view.js";
import type { Wire } from "../../../../src/core/flow/schema.js";
import { flow, prompt, script, thenWire, wire } from "../../../fixtures/flow-builders.js";

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
