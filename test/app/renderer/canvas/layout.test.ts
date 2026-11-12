import { describe, expect, it } from "vitest";
import { moveNodes, type Move } from "../../../../src/app/renderer/canvas/commands.js";
import {
  bodyFrameBounds,
  boundsOf,
  type Bounds,
} from "../../../../src/app/renderer/canvas/frames.js";
import { tidyMoves } from "../../../../src/app/renderer/canvas/layout.js";
import { toViewNodes } from "../../../../src/app/renderer/canvas/view.js";
import type { Flow, Node } from "../../../../src/core/flow/schema.js";
import {
  agent,
  flow,
  forEach,
  fork,
  join,
  loop,
  onMainFlow,
  thenWire,
} from "../../../fixtures/flow-builders.js";

const canvas = { width: 1600, height: 1000 };

const tidied = async (source: Flow, size = canvas): Promise<Flow> =>
  moveNodes(await tidyMoves(source, size)).do(source);

const steps = (count: number) => Array.from({ length: count }, (_, index) => `s${index + 1}`);

const chain = (ids: readonly string[]): Flow =>
  flow(
    ids.map((id) => agent(id)),
    ids.slice(1).map((id, index) => thenWire(ids[index] ?? "", id)),
  );

const drawnBoxes = (current: Flow): Map<string, Bounds> => {
  const view = new Map(toViewNodes(current, [], {}, null).map((node) => [node.id, node]));
  return new Map(
    current.nodes.map((node) => {
      const drawn = view.get(node.id);
      const isBar = node.type === "fork" || node.type === "join";
      if (!isBar || drawn?.width === undefined || drawn.height === undefined)
        return [node.id, boundsOf(node)];
      const { x, y } = drawn.position;
      return [node.id, { left: x, top: y, right: x + drawn.width, bottom: y + drawn.height }];
    }),
  );
};

const overlaps = (a: Bounds, b: Bounds) =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

const box = (boxes: Map<string, Bounds>, id: string): Bounds => {
  const found = boxes.get(id);
  if (found === undefined) throw new Error(`no box for ${id}`);
  return found;
};

const overlappingPairs = (current: Flow): string[] => {
  const boxes = [...drawnBoxes(current)];
  return boxes.flatMap(([id, bounds], index) =>
    boxes
      .slice(index + 1)
      .filter(([, other]) => overlaps(bounds, other))
      .map(([otherId]) => `${id}/${otherId}`),
  );
};

const isInside = (current: Flow, id: string, scope: string): boolean => {
  const parent = current.nodes.find((node) => node.id === id)?.parent;
  return parent !== undefined && (parent === scope || isInside(current, parent, scope));
};

const frameIntruders = (current: Flow): string[] => {
  const boxes = drawnBoxes(current);
  const frames = current.nodes.filter((node) => node.type === "loop" || node.type === "foreach");
  return frames.flatMap((frame) => {
    const bounds = bodyFrameBounds(current, frame);
    return current.nodes
      .filter((node) => node.id !== frame.id && !isInside(current, node.id, frame.id))
      .filter((node) => !isInside(current, frame.id, node.id))
      .filter((node) => overlaps(box(boxes, node.id), bounds))
      .map((node) => `${node.id} in ${frame.id}`);
  });
};

const span = (current: Flow): number => {
  const boxes = [...drawnBoxes(current).values()];
  return Math.max(...boxes.map(({ right }) => right)) - Math.min(...boxes.map(({ left }) => left));
};

const rowsOf = (current: Flow, ids: readonly string[]): number =>
  new Set(ids.map((id) => Math.round(positionOf(current, id).y))).size;

const nodeOf = (current: Flow, id: string): Node => {
  const found = current.nodes.find((node) => node.id === id);
  if (found === undefined) throw new Error(`no node ${id}`);
  return found;
};

const positionOf = (current: Flow, id: string) => nodeOf(current, id).position;

const parallelAndLoop = () =>
  onMainFlow(
    [
      agent("a"),
      fork("F"),
      agent("b1"),
      agent("b2"),
      join("J"),
      loop("L"),
      agent("x", { parent: "L" }),
      agent("y", { parent: "L" }),
      agent("c"),
    ],
    [
      thenWire("a", "F"),
      thenWire("F", "b1"),
      thenWire("F", "b2"),
      thenWire("b1", "J"),
      thenWire("b2", "J"),
      thenWire("J", "x"),
      thenWire("x", "y"),
      thenWire("y", "c"),
    ],
  );

const nestedFrames = () =>
  onMainFlow(
    [
      agent("a"),
      forEach("E"),
      agent("e1", { parent: "E" }),
      { ...loop("L"), parent: "E" },
      agent("l1", { parent: "L" }),
      agent("l2", { parent: "L" }),
      agent("b"),
    ],
    [thenWire("a", "e1"), thenWire("e1", "l1"), thenWire("l1", "l2"), thenWire("l2", "b")],
  );

const sectioned = (forkAfter: readonly number[], branchCount: number) => {
  const nodes: unknown[] = [];
  const wires: unknown[] = [];
  let previous = "";
  const step = (id: string) => {
    nodes.push(agent(id));
    if (previous !== "") wires.push(thenWire(previous, id));
    previous = id;
  };
  for (const [index, id] of steps(30).entries()) {
    step(id);
    if (index === 19) {
      nodes.push(loop("L"), agent("x", { parent: "L" }), agent("y", { parent: "L" }));
      wires.push(thenWire(previous, "x"), thenWire("x", "y"));
      previous = "y";
    }
    if (!forkAfter.includes(index + 1)) continue;
    const [forkId, joinId] = [`F${index + 1}`, `J${index + 1}`];
    nodes.push(fork(forkId), join(joinId));
    wires.push(thenWire(previous, forkId));
    for (const branch of Array.from({ length: branchCount }, (_, b) => `${forkId}b${b + 1}`)) {
      nodes.push(agent(branch));
      wires.push(thenWire(forkId, branch), thenWire(branch, joinId));
    }
    previous = joinId;
  }
  return onMainFlow(nodes, wires);
};

describe("tidyMoves", () => {
  it("leaves no two drawn nodes overlapping and no node inside a frame it is not in", async () => {
    const source = parallelAndLoop();
    expect(overlappingPairs(source)).not.toEqual([]);

    const after = await tidied(source);

    expect(overlappingPairs(after)).toEqual([]);
    expect(frameIntruders(after)).toEqual([]);
  });

  it("keeps a chain in flow order, each step right of the previous one or on a later row", async () => {
    const after = await tidied(
      onMainFlow([agent("A"), agent("B"), agent("C")], [thenWire("A", "B"), thenWire("B", "C")]),
    );

    const order = ["start", "A", "B", "C", "stop"];
    for (const [index, id] of order.slice(1).entries()) {
      const previous = boundsOf(nodeOf(after, order[index] ?? ""));
      const current = boundsOf(nodeOf(after, id));
      expect(current.left >= previous.right || current.top >= previous.bottom).toBe(true);
    }
  });

  it("wraps a 30-step chain into several rows that fit a 1600 x 1000 canvas", async () => {
    const ids = steps(30);

    const after = await tidied(chain(ids));

    expect(span(after)).toBeLessThanOrEqual(canvas.width);
    expect(rowsOf(after, ids)).toBeGreaterThan(1);
  });

  it("keeps a 3-step chain on one row", async () => {
    const ids = steps(3);

    const after = await tidied(chain(ids));

    expect(rowsOf(after, ids)).toBe(1);
  });

  it("never wraps a long flow inside its Parallel section", async () => {
    const before = steps(12);
    const after = steps(24).slice(12);
    const source = chain([...before, ...after]);
    const withParallel = flow(
      [...source.nodes, fork("F"), agent("p1"), agent("p2"), join("J")],
      [
        ...source.wires.filter((wire) => wire.from.node !== "s12"),
        thenWire("s12", "F"),
        thenWire("F", "p1"),
        thenWire("F", "p2"),
        thenWire("p1", "J"),
        thenWire("p2", "J"),
        thenWire("J", "s13"),
      ],
    );

    const laid = await tidied(withParallel);
    const boxes = drawnBoxes(laid);

    expect(rowsOf(laid, [...before, ...after])).toBeGreaterThan(1);
    expect(span(laid)).toBeLessThanOrEqual(canvas.width);
    for (const branch of ["p1", "p2"]) {
      expect(box(boxes, branch).left).toBeGreaterThanOrEqual(box(boxes, "F").right);
      expect(box(boxes, branch).right).toBeLessThanOrEqual(box(boxes, "J").left);
    }
  });

  it.each([
    { forkAfter: [6, 14, 24], branchCount: 2 },
    { forkAfter: [8, 22], branchCount: 3 },
    { forkAfter: [5, 15, 25], branchCount: 3 },
  ])(
    "wraps a 30-step chain with Parallel sections after $forkAfter ($branchCount branches) and a Loop into rows within 1600 px, each section on one row",
    async ({ forkAfter, branchCount }) => {
      const laid = await tidied(sectioned(forkAfter, branchCount));
      const boxes = drawnBoxes(laid);

      expect(rowsOf(laid, steps(30))).toBeGreaterThan(1);
      expect(span(laid)).toBeLessThanOrEqual(canvas.width);
      expect(overlappingPairs(laid)).toEqual([]);
      expect(frameIntruders(laid)).toEqual([]);
      for (const at of forkAfter) {
        for (const branch of Array.from({ length: branchCount }, (_, b) => `F${at}b${b + 1}`)) {
          expect(box(boxes, branch).left).toBeGreaterThanOrEqual(box(boxes, `F${at}`).right);
          expect(box(boxes, branch).right).toBeLessThanOrEqual(box(boxes, `J${at}`).left);
        }
      }
    },
  );

  it("puts nested frames' body nodes inside both frames", async () => {
    const after = await tidied(nestedFrames());

    expect(overlappingPairs(after)).toEqual([]);
    expect(frameIntruders(after)).toEqual([]);
    const outer = bodyFrameBounds(after, nodeOf(after, "E"));
    const inner = bodyFrameBounds(after, nodeOf(after, "L"));
    expect(overlaps(inner, outer)).toBe(true);
    for (const id of ["l1", "l2"]) {
      const body = boundsOf(nodeOf(after, id));
      expect(body.left).toBeGreaterThanOrEqual(outer.left);
      expect(body.top).toBeGreaterThanOrEqual(outer.top);
    }
  });

  it("never moves a note and never sets a parent", async () => {
    const source: Flow = {
      ...parallelAndLoop(),
      notes: [
        { id: "n1", text: "hi", position: { x: 0, y: 0 }, size: { width: 200, height: 100 } },
      ],
    };

    const moves: Move[] = await tidyMoves(source, canvas);

    expect(moves.length).toBeGreaterThan(0);
    expect(moves.map(({ id }) => id)).not.toContain("n1");
    expect(moves.filter((move) => move.parent !== undefined)).toEqual([]);
  });

  it("returns no moves for a flow it already tidied", async () => {
    const after = await tidied(parallelAndLoop());

    expect(await tidyMoves(after, canvas)).toEqual([]);
  });

  it("returns no moves for an empty flow", async () => {
    expect(await tidyMoves(flow([], []), canvas)).toEqual([]);
  });

  it("lays out 300 nodes in under 500 ms", async () => {
    await tidyMoves(chain(steps(3)), canvas);
    const large = chain(steps(300));

    const started = performance.now();
    await tidyMoves(large, canvas);

    expect(performance.now() - started).toBeLessThan(500);
  });
});
