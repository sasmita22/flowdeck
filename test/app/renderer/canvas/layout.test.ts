import { describe, expect, it } from "vitest";
import type { Move } from "../../../../src/app/renderer/canvas/commands.js";
import {
  bodyFrameBounds,
  boundsOf,
  flowContainerBounds,
  sideLabelSpan,
  type Bounds,
} from "../../../../src/app/renderer/canvas/frames.js";
import { LAYER_GAP, tidyMoves } from "../../../../src/app/renderer/canvas/layout.js";
import type { Flow, Node } from "../../../../src/core/flow/schema.js";
import { flowContainerOf } from "../../../../src/core/flow/structure.js";
import { featureLibrary } from "../../../fixtures/feature-library.js";
import {
  agent,
  bareFlow,
  flow,
  flowSettings,
  forEach,
  fork,
  inOneSession,
  join,
  loop,
  onMainFlow,
  output,
  sessionContainer,
  sessionLibrary,
  thenWire,
  trigger,
  wire,
  workspaceContainer,
} from "../../../fixtures/flow-builders.js";
import { box, canvas, drawnBoxes, overlaps, tidied } from "./canvas-geometry.js";

const canvasWidths = [860, 1000, 1200, 1400, 1600];

const steps = (count: number) => Array.from({ length: count }, (_, index) => `s${index + 1}`);

const thenChain = (ids: readonly string[]) =>
  ids.slice(1).map((id, index) => thenWire(ids[index] ?? "", id));

const chain = (ids: readonly string[]): Flow =>
  inOneSession(
    ids.map((id) => agent(id)),
    thenChain(ids),
  );

const chainedSessions = (sizes: readonly number[]): Flow => {
  const sessions = sizes.map((size, index) => {
    const id = `session-${index + 1}`;
    return { id, agents: steps(size).map((step) => `${id}-${step}`) };
  });
  const last = sessions.at(-1)?.id ?? "";
  return flow(
    [
      ...sessions.flatMap(({ agents }) => agents.map((id) => agent(id))),
      trigger("canvas-start"),
      output("canvas-stop"),
    ],
    [
      ...sessions.flatMap(({ agents }) => thenChain(agents)),
      ...sessions
        .slice(1)
        .map(({ id }, index) => wire(sessions[index]?.id ?? "", "flow-out", id, "flow-in")),
      wire("canvas-start", "out", "session-1", "flow-in"),
      wire(last, "flow-out", "canvas-stop", "in"),
    ],
    flowSettings,
    { containers: sessions.map(({ id, agents }) => sessionContainer(agents, { id })) },
  );
};

const library = (id: string) => ({
  id,
  label: id,
  position: { x: 0, y: 0 },
  type: "library",
  settings: { libraryId: "shared", label: "Shared", overrides: {} },
});

const frameThenLibraries = (
  container: { id: string; nodes: string[] },
  libraries: readonly string[],
  tail: readonly ReturnType<typeof output>[],
): Flow =>
  flow(
    [...container.nodes.map((id) => agent(id)), ...libraries.map(library), ...tail],
    [
      ...thenChain(container.nodes),
      wire(container.id, "flow-out", libraries[0] ?? "", "in"),
      ...thenChain([...libraries, ...tail.map(({ id }) => id)]),
    ],
    flowSettings,
    { containers: [container] },
  );

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

const startGap = (current: Flow, frameId: string): number => {
  const start = nodeOf(current, "canvas-start");
  return (
    flowContainerBounds(current, frameId).left -
    (boundsOf(start).right + sideLabelSpan(start.label))
  );
};

const topOf = (current: Flow, id: string): string => {
  const parent = nodeOf(current, id).parent;
  return parent === undefined ? id : topOf(current, parent);
};

const union = (a: Bounds, b: Bounds): Bounds => ({
  left: Math.min(a.left, b.left),
  top: Math.min(a.top, b.top),
  right: Math.max(a.right, b.right),
  bottom: Math.max(a.bottom, b.bottom),
});

const membersOf = (current: Flow, containerId: string): string[] =>
  current.containers.find(({ id }) => id === containerId)?.nodes ?? [];

const packedRows = (current: Flow, containerId: string) => {
  const boxes = drawnBoxes(current);
  const items = membersOf(current, containerId)
    .map((id) => {
      const node = nodeOf(current, id);
      const drawn = box(boxes, id);
      const isFrame = node.type === "loop" || node.type === "foreach";
      return { id, bounds: isFrame ? union(drawn, bodyFrameBounds(current, node)) : drawn };
    })
    .sort((a, b) => a.bounds.top - b.bounds.top);
  const rows: { bottom: number; items: typeof items }[] = [];
  for (const item of items) {
    const last = rows.at(-1);
    if (last !== undefined && item.bounds.top - last.bottom < LAYER_GAP) {
      last.items.push(item);
      last.bottom = Math.max(last.bottom, item.bounds.bottom);
    } else rows.push({ bottom: item.bounds.bottom, items: [item] });
  }
  const rowOf = new Map(rows.flatMap((row, index) => row.items.map(({ id }) => [id, index])));
  const firstOf = rows.map((row) => {
    const leftmost = row.items.reduce((a, b) => (b.bounds.left < a.bounds.left ? b : a));
    return new Set(
      row.items.filter(({ bounds }) => bounds.left < leftmost.bounds.right).map(({ id }) => id),
    );
  });
  return { rows, rowOf, firstOf };
};

const unlevelledBlocks = (current: Flow, containerId: string): string[] => {
  const boxes = drawnBoxes(current);
  const middle = (id: string) => (box(boxes, id).top + box(boxes, id).bottom) / 2;
  const { rows, rowOf } = packedRows(current, containerId);
  const blockOf = new Map<string, string>();
  for (const row of rows) {
    let right = -Infinity;
    let block = "";
    for (const { id, bounds } of [...row.items].sort((a, b) => a.bounds.left - b.bounds.left)) {
      if (bounds.left >= right) block = id;
      blockOf.set(id, block);
      right = Math.max(right, bounds.right);
    }
  }
  const isPlainNode = (id: string) =>
    current.nodes.some((node) => node.id === id && node.type !== "fork" && node.type !== "join");
  const receivers = new Map<string, { from: string; to: string }[]>();
  for (const { from, to, kind } of current.wires) {
    if (kind !== "then" || !isPlainNode(from.node) || !isPlainNode(to.node)) continue;
    const [source, target] = [topOf(current, from.node), topOf(current, to.node)];
    const [sourceBlock, targetBlock] = [blockOf.get(source), blockOf.get(target)];
    if (sourceBlock === undefined || targetBlock === undefined || sourceBlock === targetBlock)
      continue;
    if (rowOf.get(source) !== rowOf.get(target)) continue;
    if (box(boxes, to.node).left <= box(boxes, from.node).left) continue;
    receivers.set(targetBlock, [
      ...(receivers.get(targetBlock) ?? []),
      { from: from.node, to: to.node },
    ]);
  }
  return [...receivers]
    .filter(([, wires]) => !wires.some(({ from, to }) => Math.abs(middle(from) - middle(to)) < 1))
    .map(
      ([block, wires]) => `${block}: ${wires.map(({ from, to }) => `${from} -> ${to}`).join(", ")}`,
    );
};

const backwardOrStrayWires = (current: Flow, containerId: string): string[] => {
  const members = new Set(membersOf(current, containerId));
  const { rowOf, firstOf } = packedRows(current, containerId);
  const boxes = drawnBoxes(current);
  const isNode = (id: string) => current.nodes.some((node) => node.id === id);
  const thenWires = current.wires.filter(({ kind }) => kind === "then");
  const incoming = (id: string) => thenWires.filter(({ to }) => to.node === id).length;
  return thenWires
    .filter(({ from, to }) => isNode(from.node) && isNode(to.node))
    .filter(
      ({ from, to }) =>
        members.has(topOf(current, from.node)) && members.has(topOf(current, to.node)),
    )
    .filter(({ from, to }) => {
      const source = rowOf.get(topOf(current, from.node)) ?? -1;
      const target = rowOf.get(topOf(current, to.node)) ?? -1;
      if (target < source) return true;
      if (target === source) return box(boxes, to.node).left <= box(boxes, from.node).left;
      if (nodeOf(current, from.node).type === "branch" || incoming(to.node) >= 2) return false;
      return target !== source + 1 || !firstOf[target]?.has(topOf(current, to.node));
    })
    .map(({ from, to }) => `${from.node} -> ${to.node}`);
};

const nodeOf = (current: Flow, id: string): Node => {
  const found = current.nodes.find((node) => node.id === id);
  if (found === undefined) throw new Error(`no node ${id}`);
  return found;
};

const positionOf = (current: Flow, id: string) => nodeOf(current, id).position;

const hasSideLabel = (node: Node): boolean => node.type === "trigger" || node.type === "output";

const gapsAlong = (current: Flow, ids: readonly string[]) => {
  const boxes = drawnBoxes(current);
  const rightOf = (id: string): number => {
    const node = nodeOf(current, id);
    const { right } = box(boxes, id);
    return hasSideLabel(node) ? right + sideLabelSpan(node.label) : right;
  };
  return ids.slice(1).map((id, index) => {
    const previous = ids[index] ?? "";
    return { between: `${previous} -> ${id}`, gap: box(boxes, id).left - rightOf(previous) };
  });
};

const expectSpaced = (current: Flow, ids: readonly string[]) => {
  for (const { between, gap } of gapsAlong(current, ids))
    expect(gap, between).toBeGreaterThanOrEqual(LAYER_GAP);
};

const withStartLabel = (source: Flow, label: string): Flow => ({
  ...source,
  nodes: source.nodes.map((node) => (node.id === "start" ? { ...node, label } : node)),
});

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

const sessionOnly = (source: Flow): Flow => {
  const inSession = new Set(
    source.nodes
      .filter((node) => flowContainerOf(source, node.id)?.kind === "session")
      .map((node) => node.id),
  );
  return inOneSession(
    source.nodes.filter((node) => inSession.has(node.id)),
    source.wires.filter((wire) => inSession.has(wire.from.node) && inSession.has(wire.to.node)),
  );
};

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
  return sessionOnly(onMainFlow(nodes, wires));
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

  it("spaces Start, each agent and Stop at least LAYER_GAP apart, counting Start's and Stop's side labels in their width", async () => {
    const after = await tidied(onMainFlow([agent("a"), agent("b")], [thenWire("a", "b")]));

    expectSpaced(after, ["start", "a", "b", "stop"]);
  });

  it("spaces the nodes of a Parallel section at least LAYER_GAP apart", async () => {
    const after = await tidied(
      onMainFlow(
        [agent("a"), fork("F"), agent("b1"), agent("b2"), join("J"), agent("c")],
        [
          thenWire("a", "F"),
          thenWire("F", "b1"),
          thenWire("F", "b2"),
          thenWire("b1", "J"),
          thenWire("b2", "J"),
          thenWire("J", "c"),
        ],
      ),
      { width: 4000, height: 1000 },
    );

    expectSpaced(after, ["start", "a", "F", "b1", "J", "c", "stop"]);
    expectSpaced(after, ["F", "b2", "J"]);
  });

  it.each([
    { frame: "Loop", container: loop("L") },
    { frame: "For each", container: forEach("L") },
  ])("spaces the body of a $frame frame at least LAYER_GAP apart", async ({ container }) => {
    const after = await tidied(
      onMainFlow(
        [agent("a"), container, agent("x", { parent: "L" }), agent("y", { parent: "L" })],
        [thenWire("a", "x"), thenWire("x", "y")],
      ),
    );

    expectSpaced(after, ["x", "y"]);
  });

  it("pushes the node after Start further right when Start's label is longer", async () => {
    const source = onMainFlow([agent("a")], []);

    const short = await tidied(withStartLabel(source, "go"));
    const long = await tidied(withStartLabel(source, "When the nightly report is due"));

    expect(positionOf(long, "a").x - positionOf(long, "start").x).toBeGreaterThan(
      positionOf(short, "a").x - positionOf(short, "start").x,
    );
  });

  it("keeps the four-agent chain an assistant ask adds on one row in a 1180 px canvas", async () => {
    const ids = ["p1", "agent-1", "agent-2", "agent-3"];
    const labels: Record<string, string> = {
      "agent-1": "Lint",
      "agent-2": "Tests",
      "agent-3": "Docs",
    };
    const source = inOneSession(
      ids.map((id) => ({ ...agent(id), label: labels[id] ?? id })),
      ids.slice(1).map((id, index) => thenWire(ids[index] ?? "", id)),
    );

    const after = await tidied(source, { width: 1180, height: 840 });

    expect(rowsOf(after, ids)).toBe(1);
  });

  it("keeps nodes added outside every container, wired after a member, in flow order on one row", async () => {
    const ids = ["p1", "agent-1", "agent-2", "agent-3"];
    const seeded = flow([agent("p1")], []);
    const source: Flow = {
      ...seeded,
      nodes: [...seeded.nodes, ...ids.slice(1).map((id) => agent(id) as Node)],
      wires: [
        ...seeded.wires,
        ...ids.slice(1).map((id, index) => thenWire(ids[index] ?? "", id) as Flow["wires"][number]),
      ],
    };

    const after = await tidied(source, { width: 1180, height: 840 });

    expect(rowsOf(after, ids)).toBe(1);
    for (const [index, id] of ids.slice(1).entries())
      expect(positionOf(after, id).x).toBeGreaterThan(positionOf(after, ids[index] ?? "").x);
  });

  it("wraps a 30-step chain into several rows that fit a 1600 x 1000 canvas", async () => {
    const ids = steps(30);

    const after = await tidied(chain(ids));

    expect(span(after)).toBeLessThanOrEqual(canvas.width);
    expect(rowsOf(after, ids)).toBeGreaterThan(1);
  });

  it("wraps a chain made only of empty Loop frames into several rows", async () => {
    const ids = steps(6);
    const source = inOneSession(
      ids.map((id) => loop(id)),
      ids.slice(1).map((id, index) => thenWire(ids[index] ?? "", id)),
    );

    const after = await tidied(source, { width: 600, height: 1000 });

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
    const withParallel = inOneSession(
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

  it("leaves no two container frames overlapping", async () => {
    const source = parallelAndLoop();
    const frames = (current: Flow) =>
      current.containers.map(({ id }) => [id, flowContainerBounds(current, id)] as const);
    const clashes = (current: Flow) =>
      frames(current).flatMap(([id, bounds], index) =>
        frames(current)
          .slice(index + 1)
          .filter(([, other]) => overlaps(bounds, other))
          .map(([otherId]) => `${id}/${otherId}`),
      );
    expect(clashes(source)).not.toEqual([]);

    const after = await tidied(source);

    expect(clashes(after)).toEqual([]);
  });

  it("lays the canvas Start out left of the workspace's frame and the canvas Stop right of it", async () => {
    const after = await tidied(parallelAndLoop());
    const frame = flowContainerBounds(after, "workspace-1");
    const start = nodeOf(after, "canvas-start");

    expect(boundsOf(start).right + sideLabelSpan(start.label)).toBeLessThan(frame.left);
    expect(positionOf(after, "canvas-stop").x).toBeGreaterThan(frame.right);
  });

  it("puts the canvas Start, side label included, left of a session library's wrapped frame", async () => {
    expect(startGap(await tidied(featureLibrary), "session-1")).toBeGreaterThan(0);
  });

  it("puts the canvas Stop right of a session library's wrapped frame", async () => {
    const after = await tidied(featureLibrary);

    expect(positionOf(after, "canvas-stop").x).toBeGreaterThan(
      flowContainerBounds(after, "session-1").right,
    );
  });

  it.each([4, 5])(
    "keeps the canvas Start left and the canvas Stop right of a %i-agent session library that fits the canvas",
    async (count) => {
      const ids = steps(count);

      const after = await tidied(
        sessionLibrary(
          ids.map((id) => agent(id)),
          thenChain(ids),
        ),
      );

      expect(startGap(after, "session-1")).toBeGreaterThan(0);
      expect(positionOf(after, "canvas-stop").x).toBeGreaterThan(
        flowContainerBounds(after, "session-1").right,
      );
    },
  );

  it.each([1400, 1600])(
    "fits a wrapped session library's frame within a %i px canvas",
    async (width) => {
      const frame = flowContainerBounds(
        await tidied(featureLibrary, { ...canvas, width }),
        "session-1",
      );

      expect(frame.right - frame.left).toBeLessThanOrEqual(width);
    },
  );

  it.each(canvasWidths)(
    "lays a wrapped frame's rows out so every then-wire reads forward in a %i px canvas",
    async (width) => {
      const after = await tidied(featureLibrary, { ...canvas, width });

      expect(backwardOrStrayWires(after, "session-1")).toEqual([]);
    },
  );

  it.each(canvasWidths)(
    "keeps the inner Stop level with the Branch that sends to it in a %i px canvas",
    async (width) => {
      const boxes = drawnBoxes(await tidied(featureLibrary, { ...canvas, width }));
      const middle = (id: string) => (box(boxes, id).top + box(boxes, id).bottom) / 2;

      expect(middle("stop")).toBe(middle("b2"));
    },
  );

  it.each(canvasWidths)(
    "lines each block in a packed row up with the node that sends to it in a %i px canvas",
    async (width) => {
      expect(
        unlevelledBlocks(await tidied(featureLibrary, { ...canvas, width }), "session-1"),
      ).toEqual([]);
    },
  );

  it.each(canvasWidths)(
    "lets no two node boxes overlap in a wrapped session library in a %i px canvas",
    async (width) => {
      const after = await tidied(featureLibrary, { ...canvas, width });

      expect(overlappingPairs(after)).toEqual([]);
      expect(frameIntruders(after)).toEqual([]);
    },
  );

  it("returns no moves when a wrapped session library is already tidy", async () => {
    expect(await tidyMoves(await tidied(featureLibrary), canvas)).toEqual([]);
  });

  it("still wraps a frameless chain wider than the canvas into rows that fit it", async () => {
    const ids = steps(30);

    const after = await tidied(
      bareFlow(
        ids.map((id) => agent(id)),
        thenChain(ids),
      ),
    );

    expect(span(after)).toBeLessThanOrEqual(canvas.width);
    expect(rowsOf(after, ids)).toBeGreaterThan(1);
  });

  it("wraps six chained session frames that each fit the canvas onto more than one row", async () => {
    const firstAgents = steps(6).map((_, index) => `session-${index + 1}-s1`);

    const after = await tidied(chainedSessions([4, 4, 4, 4, 4, 4]));

    expect(rowsOf(after, firstAgents)).toBeGreaterThan(1);
  });

  it("wraps chained session frames onto more than one row when one of them is packed", async () => {
    const sizes = [15, 4, 4, 4, 4];
    const firstAgentsOfEqualFrames = sizes.slice(1).map((_, index) => `session-${index + 2}-s1`);

    const after = await tidied(chainedSessions(sizes));

    expect(rowsOf(after, firstAgentsOfEqualFrames)).toBeGreaterThan(1);
  });

  it.each([
    {
      frame: "a 3-agent workspace",
      container: workspaceContainer(steps(3)),
      tail: [output("canvas-stop")],
    },
    { frame: "a 15-agent session", container: sessionContainer(steps(15)), tail: [] },
  ])(
    "wraps root items after a one-frame canvas onto more than one row: $frame",
    async ({ container, tail }) => {
      const libraries = steps(8).map((id) => `lib-${id}`);

      const after = await tidied(frameThenLibraries(container, libraries, tail));

      expect(rowsOf(after, libraries)).toBeGreaterThan(1);
    },
  );

  it("keeps a session that fits the canvas on one row when the canvas path is wider than the canvas", async () => {
    const source = flow(
      [
        { ...trigger("start"), label: "When the report is due" },
        { ...agent("a"), label: "Write" },
        { ...output("stop"), label: "Report summary" },
      ],
      [thenWire("start", "a"), thenWire("a", "stop")],
    );

    const after = await tidied(source, { width: 1000, height: 700 });

    expect(rowsOf(after, ["start", "a", "stop"])).toBe(1);
    expect(rowsOf(after, ["workspace-1-start", "workspace-1-stop"])).toBe(1);
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
    expect(await tidyMoves(inOneSession([], []), canvas)).toEqual([]);
  });

  it("lays out 300 nodes in under 500 ms", async () => {
    await tidyMoves(chain(steps(3)), canvas);
    const large = chain(steps(300));

    const started = performance.now();
    await tidyMoves(large, canvas);

    expect(performance.now() - started).toBeLessThan(500);
  });
});
