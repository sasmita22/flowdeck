import { describe, expect, it } from "vitest";
import { createCanvasStore } from "../../../../src/app/renderer/canvas/store.js";
import type { Flow } from "../../../../src/core/flow/schema.js";
import {
  agent,
  flow,
  flowSettings,
  gate,
  loop,
  output,
  sessionContainer,
  thenWire,
  trigger,
} from "../../../fixtures/flow-builders.js";

const at = <N extends object>(node: N, x: number, y: number) => ({ ...node, position: { x, y } });

const loaded = (current: Flow) => {
  const store = createCanvasStore();
  store.getState().load(current);
  return store;
};

const nodeOf = (current: Flow, id: string) => current.nodes.find((node) => node.id === id);
const parentOf = (current: Flow, id: string) => nodeOf(current, id)?.parent;

const loopWithBody = () =>
  flow([at(loop("L"), 0, 0), at(agent("P", { parent: "L" }), 0, 80), at(agent("S"), 400, 0)], []);

const drag = (
  store: ReturnType<typeof loaded>,
  moves: Record<string, { x: number; y: number }>,
) => {
  for (const [id, position] of Object.entries(moves)) store.getState().dragTo(id, position);
  store.getState().endDrag(Object.keys(moves));
};

describe("dropping a new node onto a frame", () => {
  it("puts an Agent dropped on a Loop frame in its body, as one undoable step", () => {
    const store = loaded(flow([at(loop("C"), 0, 0)], []));

    store.getState().drop("agent", { x: 100, y: 60 });

    expect(nodeOf(store.getState().flow, "agent-1")).toMatchObject({
      parent: "C",
      position: { x: 100, y: 60 },
    });
    expect(store.getState().undoStack).toHaveLength(1);

    store.getState().undo();
    expect(nodeOf(store.getState().flow, "agent-1")).toBeUndefined();

    store.getState().redo();
    expect(parentOf(store.getState().flow, "agent-1")).toBe("C");
  });

  it("leaves a node dropped outside every frame at the top level", () => {
    const store = loaded(flow([at(loop("L"), 0, 0)], []));

    store.getState().drop("agent", { x: 600, y: 600 });

    expect(nodeOf(store.getState().flow, "agent-1")).not.toHaveProperty("parent");
  });

  it.each(["loop"] as const)("never puts a dropped %s inside a frame", (type) => {
    const store = loaded(flow([at(loop("L"), 0, 0)], []));

    store.getState().drop(type, { x: 100, y: 60 });

    expect(nodeOf(store.getState().flow, `${type}-1`)).not.toHaveProperty("parent");
  });

  it.each([
    ["trigger", "Start"],
    ["output", "Stop"],
  ] as const)("refuses a %s dropped on a frame, and says why", (type, label) => {
    const store = loaded(flow([at(loop("L"), 0, 0)], []));
    const before = store.getState().flow;

    store.getState().drop(type, { x: 100, y: 60 });

    expect(store.getState().flow).toBe(before);
    expect(store.getState().undoStack).toEqual([]);
    expect(store.getState().message).toBe(
      `Can't drop ${label} into L: ${label} cannot be inside loop L.`,
    );
  });

  it("puts a dropped gate in the body", () => {
    const store = loaded(flow([at(loop("L"), 0, 0)], []));

    store.getState().drop("gate", { x: 100, y: 60 });

    expect(parentOf(store.getState().flow, "gate-1")).toBe("L");
  });

  it("keeps a dropped body node clear of the frame's label", () => {
    const store = loaded(flow([at(loop("L"), 0, 0)], []));

    store.getState().drop("agent", { x: 0, y: 0 });

    const dropped = nodeOf(store.getState().flow, "agent-1");
    expect(dropped?.parent).toBe("L");
    expect(dropped?.position.x).toBeGreaterThanOrEqual(170);
  });
});

describe("dragging a node into and out of a frame", () => {
  it("puts a node dragged into a frame in its body, with its move, as one undoable step", () => {
    const store = loaded(loopWithBody());
    const before = store.getState().flow;

    drag(store, { S: { x: 20, y: 100 } });

    expect(nodeOf(store.getState().flow, "S")).toMatchObject({
      parent: "L",
      position: { x: 20, y: 100 },
    });
    expect(store.getState().undoStack).toHaveLength(1);

    store.getState().undo();
    expect(store.getState().flow).toEqual(before);

    store.getState().redo();
    expect(parentOf(store.getState().flow, "S")).toBe("L");
  });

  it("takes a body node dragged out of its frame out of the body, as one undoable step", () => {
    const store = loaded(loopWithBody());
    const before = store.getState().flow;

    drag(store, { P: { x: 600, y: 400 } });

    expect(nodeOf(store.getState().flow, "P")).not.toHaveProperty("parent");
    expect(nodeOf(store.getState().flow, "P")?.position).toEqual({ x: 600, y: 400 });

    store.getState().undo();
    expect(store.getState().flow).toEqual(before);
  });

  it("keeps a body node moved within its frame in the body", () => {
    const store = loaded(loopWithBody());

    drag(store, { P: { x: 10, y: 90 } });

    expect(parentOf(store.getState().flow, "P")).toBe("L");
  });

  it("refuses a move into a frame that gives its body a second entry, and says why", () => {
    const store = loaded(
      flow(
        [
          at(agent("A"), -400, 0),
          at(loop("L"), 0, 0),
          at(agent("P", { parent: "L" }), 0, 80),
          at(agent("B"), 400, 0),
        ],
        [thenWire("A", "P"), thenWire("A", "B")],
      ),
    );
    const before = store.getState().flow;

    drag(store, { B: { x: 20, y: 100 } });

    expect(store.getState().flow).toBe(before);
    expect(store.getState().undoStack).toEqual([]);
    expect(store.getState().dragPositions).toEqual({});
    expect(store.getState().message).toBe("Can't move B into L: Loop body has 2 entries: P, B.");
  });
});

describe("dragging a Trigger or Output into a frame", () => {
  it("refuses it, and says why", () => {
    const store = loaded(
      flow(
        [at(loop("L"), 0, 0), at(agent("P", { parent: "L" }), 0, 80), at(output("O"), 400, 0)],
        [],
      ),
    );
    const before = store.getState().flow;

    drag(store, { O: { x: 20, y: 100 } });

    expect(store.getState().flow).toBe(before);
    expect(store.getState().message).toBe("Can't move O into L: O cannot be inside loop L.");
  });

  it("still takes a Gate", () => {
    const store = loaded(
      flow(
        [at(loop("L"), 0, 0), at(agent("P", { parent: "L" }), 0, 80), at(gate("G"), 400, 0)],
        [],
      ),
    );

    drag(store, { G: { x: 20, y: 100 } });

    expect(parentOf(store.getState().flow, "G")).toBe("L");
  });
});

describe("moving a container", () => {
  it("moves its body by the same distance, as one undoable step", () => {
    const store = loaded(loopWithBody());
    const before = store.getState().flow;

    drag(store, { L: { x: 100, y: 50 } });

    const after = store.getState().flow;
    expect(nodeOf(after, "L")?.position).toEqual({ x: 100, y: 50 });
    expect(nodeOf(after, "P")).toMatchObject({ parent: "L", position: { x: 100, y: 130 } });
    expect(nodeOf(after, "S")?.position).toEqual({ x: 400, y: 0 });
    expect(store.getState().undoStack).toHaveLength(1);

    store.getState().undo();
    expect(store.getState().flow).toEqual(before);
  });

  it("moves a body node dragged along with its container only once", () => {
    const store = loaded(loopWithBody());

    drag(store, { L: { x: 100, y: 50 }, P: { x: 100, y: 130 } });

    expect(nodeOf(store.getState().flow, "P")).toMatchObject({
      parent: "L",
      position: { x: 100, y: 130 },
    });
  });
});

describe("deleting a container", () => {
  it("deletes its body and their wires with it, and one undo brings all back", () => {
    const store = loaded(
      flow(
        [
          at(agent("A"), -400, 0),
          at(loop("L"), 0, 0),
          at(agent("P", { parent: "L" }), 0, 80),
          at(agent("Q", { parent: "L" }), 240, 80),
          at(agent("B"), 600, 0),
        ],
        [thenWire("A", "P"), thenWire("P", "Q"), thenWire("L", "B")],
        flowSettings,
        { containers: [sessionContainer(["A", "L", "B"])] },
      ),
    );
    const before = store.getState().flow;

    store.getState().deleteNodes(["L"]);

    const after = store.getState().flow;
    expect(after.nodes.map((node) => node.id)).toEqual(["A", "B"]);
    expect(after.wires).toEqual([]);
    expect(after.nodes.some((node) => node.parent !== undefined)).toBe(false);
    expect(store.getState().undoStack).toHaveLength(1);

    store.getState().undo();
    expect(store.getState().flow).toEqual(before);

    store.getState().redo();
    expect(store.getState().flow).toEqual(after);
  });
});

describe("containers never nest", () => {
  const sessionAt = () =>
    flow(
      [at(trigger("s"), 0, 0), at(output("t"), 600, 0), at(loop("L"), 0, 600)],
      [thenWire("s", "t")],
      flowSettings,
      { containers: [sessionContainer(["s", "t"])] },
    );

  const membersOf = (current: Flow, id: string) =>
    current.containers.find((container) => container.id === id)?.nodes;

  it.each(["session", "workspace"] as const)(
    "refuses a %s dropped inside a session container, and says why",
    (type) => {
      const store = loaded(sessionAt());
      const before = store.getState().flow;

      store.getState().drop(type, { x: 200, y: 10 });

      expect(store.getState().flow).toBe(before);
      expect(store.getState().undoStack).toEqual([]);
      expect(store.getState().message).toMatch(/^Can't drop /);
    },
  );

  it.each(["session", "workspace"] as const)(
    "refuses a %s dropped inside a Loop's frame, and says why",
    (type) => {
      const store = loaded(sessionAt());
      const before = store.getState().flow;

      store.getState().drop(type, { x: 100, y: 660 });

      expect(store.getState().flow).toBe(before);
      expect(store.getState().undoStack).toEqual([]);
      expect(store.getState().message).toMatch(/^Can't drop /);
    },
  );

  it("puts a Loop dropped inside a session container in that container, not in a body", () => {
    const store = loaded(sessionAt());

    store.getState().drop("loop", { x: 200, y: 10 });

    const after = store.getState().flow;
    expect(membersOf(after, "session-1")).toEqual(["s", "t", "loop-1"]);
    expect(nodeOf(after, "loop-1")).not.toHaveProperty("parent");
  });

  it("puts a Loop dragged into a session container in it, its body following through the Loop", () => {
    const store = loaded(
      flow(
        [
          at(trigger("s"), 0, 0),
          at(output("t"), 600, 0),
          at(loop("L"), 0, 600),
          at(agent("P", { parent: "L" }), 0, 680),
        ],
        [thenWire("s", "t")],
        flowSettings,
        { containers: [sessionContainer(["s", "t"])] },
      ),
    );

    drag(store, { L: { x: 200, y: 10 } });

    const after = store.getState().flow;
    expect(membersOf(after, "session-1")).toEqual(["s", "t", "L"]);
    expect(parentOf(after, "P")).toBe("L");
  });
});
