import { describe, expect, it, vi } from "vitest";
import {
  createCanvasStore,
  isNodeType,
  labelFor,
  newCanvasFlow,
  nextNodeId,
  nodeDefaults,
  nodeLabel,
  placeNode,
  selectCanvasEmpty,
  selectDirty,
  selectFieldIssues,
  selectNodeIssues,
  selectSelectedNode,
} from "../../../../src/app/renderer/canvas/store.js";
import { nodeWidth } from "../../../../src/app/renderer/canvas/frames.js";
import { nodeLook } from "../../../../src/app/renderer/nodes/look.js";
import { validate } from "../../../../src/core/compiler/validate.js";
import { addNode, moveNodes, updateNode } from "../../../../src/app/renderer/canvas/commands.js";
import { tidyMoves } from "../../../../src/app/renderer/canvas/layout.js";

vi.mock("../../../../src/app/renderer/canvas/layout.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../../src/app/renderer/canvas/layout.js")>();
  return { ...actual, tidyMoves: vi.fn(actual.tidyMoves) };
});
import {
  NodeType,
  parseFlow,
  type Flow,
  type Node,
  type Session,
} from "../../../../src/core/flow/schema.js";
import {
  agent,
  flow,
  forEach,
  fork,
  hardstop,
  join,
  loop,
  onMainFlow,
  output,
  thenWire,
  trigger,
} from "../../../fixtures/flow-builders.js";

const unfinished = new Set(["required-settings", "repo-required", "one-start", "stop-required"]);

type Store = ReturnType<typeof createCanvasStore>;

const nodeIdRule = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

const structural = (current: Flow) =>
  validate(current).filter((error) => !unfinished.has(error.rule));

const expectValid = (current: Flow) => {
  expect(parseFlow(current)).toEqual(current);
  expect(structural(current)).toEqual([]);
};

const act = (store: Store, action: (state: ReturnType<Store["getState"]>) => unknown) => {
  const result = action(store.getState());
  expectValid(store.getState().flow);
  return result;
};

const end = (node: string, port: string) => ({ node, port });
const then = (from: string, to: string) => ({
  kind: "then",
  from: end(from, "out"),
  to: end(to, "in"),
});

const dropFour = (store: Store) => {
  act(store, (s) => s.drop("agent", { x: 0, y: 0 }));
  act(store, (s) => s.drop("agent", { x: 200, y: 0 }));
  act(store, (s) => s.drop("gate", { x: 0, y: 200 }));
  act(store, (s) => s.drop("gate", { x: 200, y: 200 }));
  const [a, b, c, d] = store.getState().flow.nodes.map((node) => node.id);
  if (a === undefined || b === undefined || c === undefined || d === undefined) {
    throw new Error("expected four nodes");
  }
  return { a, b, c, d };
};

const buildAt3 = () => {
  const store = createCanvasStore();
  const { a, b, c, d } = dropFour(store);
  for (const [from, to] of [
    [a, b],
    [a, d],
    [c, b],
    [b, d],
  ] as const) {
    expect(act(store, (s) => s.connect(end(from, "out"), end(to, "in")))).toBe(true);
  }
  return { store, a, b, c, d };
};

describe("createCanvasStore", () => {
  it("starts with an empty flow, no selection and empty stacks", () => {
    const state = createCanvasStore().getState();

    expect(state.flow).toEqual(newCanvasFlow());
    expect(state.flow.nodes).toEqual([]);
    expect(state.selection).toEqual([]);
    expect(state.undoStack).toEqual([]);
    expect(state.redoStack).toEqual([]);
    expect(state.dragPositions).toEqual({});
    expectValid(state.flow);
  });

  it("is ready by default, with the starting flow as the saved flow and clean", () => {
    const state = createCanvasStore().getState();

    expect(state.ready).toBe(true);
    expect(state.saved).toEqual(newCanvasFlow());
    expect(selectDirty(state)).toBe(false);
  });
});

describe("drop", () => {
  it("adds one Agent at the drop position with core defaults, selected alone", () => {
    const store = createCanvasStore();

    act(store, (s) => s.drop("agent", { x: 120, y: 80 }));

    const state = store.getState();
    expect(state.flow.nodes).toEqual([
      {
        id: "agent-1",
        type: "agent",
        label: "Agent",
        position: { x: 120, y: 80 },
        settings: { role: "", instructions: "", model: "sonnet", tools: [] },
      },
    ]);
    expect(state.flow.wires).toEqual([]);
    expect(state.selection).toEqual(["agent-1"]);
    expect(state.undoStack).toHaveLength(1);
  });

  it("adds one Gate at the drop position with core defaults, selected alone", () => {
    const store = createCanvasStore();

    act(store, (s) => s.drop("gate", { x: 40, y: 300 }));

    const state = store.getState();
    expect(state.flow.nodes).toEqual([
      {
        id: "gate-1",
        type: "gate",
        label: "Gate",
        position: { x: 40, y: 300 },
        settings: { shown: "", skippable: false },
      },
    ]);
    expect(state.selection).toEqual(["gate-1"]);
  });

  it("replaces the selection with the node dropped second", () => {
    const store = createCanvasStore();

    act(store, (s) => s.drop("agent", { x: 0, y: 0 }));
    act(store, (s) => s.drop("agent", { x: 50, y: 50 }));

    expect(store.getState().flow.nodes.map((node) => node.id)).toEqual(["agent-1", "agent-2"]);
    expect(store.getState().selection).toEqual(["agent-2"]);
  });
});

describe("connect", () => {
  const twoNodes = () => {
    const store = createCanvasStore();
    act(store, (s) => s.drop("agent", { x: 0, y: 0 }));
    act(store, (s) => s.drop("gate", { x: 200, y: 0 }));
    return store;
  };

  it("adds exactly one then wire from an output port to an input port", () => {
    const store = twoNodes();

    const accepted = act(store, (s) => s.connect(end("agent-1", "out"), end("gate-1", "in")));

    expect(accepted).toBe(true);
    expect(store.getState().flow.wires).toEqual([then("agent-1", "gate-1")]);
    expect(store.getState().undoStack).toHaveLength(3);
  });

  it("wires Start to a Stop freshly dropped with its empty output", () => {
    const store = createCanvasStore();
    act(store, (s) => s.drop("trigger", { x: 0, y: 0 }));
    act(store, (s) => s.drop("output", { x: 200, y: 0 }));
    const [start, stop] = store.getState().flow.nodes;
    if (start === undefined || stop === undefined) throw new Error("expected two nodes");
    expect(stop.settings).toEqual({ name: "", type: "" });

    const accepted = act(store, (s) => s.connect(end(start.id, "out"), end(stop.id, "in")));

    expect(store.getState().message).toBeNull();
    expect(accepted).toBe(true);
    expect(store.getState().flow.wires).toEqual([then(start.id, stop.id)]);
  });

  const refused: [
    string,
    boolean,
    { node: string; port: string },
    { node: string; port: string },
  ][] = [
    ["a self-loop", false, end("agent-1", "out"), end("agent-1", "in")],
    ["a cycle", true, end("gate-1", "out"), end("agent-1", "in")],
    ["output to output", false, end("agent-1", "out"), end("gate-1", "out")],
    ["input to input", false, end("agent-1", "in"), end("gate-1", "in")],
    ["a duplicate wire", true, end("agent-1", "out"), end("gate-1", "in")],
    ["an unknown node", false, end("agent-1", "out"), end("ghost-1", "in")],
    ["an unknown input port", false, end("agent-1", "out"), end("gate-1", "nope")],
    ["an unknown output port", false, end("agent-1", "nope"), end("gate-1", "in")],
  ];

  it.each(refused)("refuses %s and records nothing", (_name, wired, from, to) => {
    const store = twoNodes();
    if (wired) act(store, (s) => s.connect(end("agent-1", "out"), end("gate-1", "in")));
    const before = store.getState();

    const accepted = act(store, (s) => s.connect(from, to));

    expect(accepted).toBe(false);
    expect(store.getState().flow).toEqual(before.flow);
    expect(store.getState().undoStack).toEqual(before.undoStack);
  });
});

describe("delete", () => {
  it("deletes the selected node with its three wires and undo restores all four exactly", () => {
    const { store, a, b, c, d } = buildAt3();
    act(store, (s) => s.select([b]));
    const before = store.getState().flow;

    act(store, (s) => s.deleteSelection());

    const after = store.getState();
    expect(after.flow.nodes.map((node) => node.id)).toEqual([a, c, d]);
    expect(after.flow.wires).toEqual([then(a, d)]);
    expect(
      before.nodes.length + before.wires.length - after.flow.nodes.length - after.flow.wires.length,
    ).toBe(4);
    expect(after.selection).not.toContain(b);

    act(store, (s) => s.undo());

    expect(store.getState().flow).toEqual(before);
  });

  it("deletes by id the same way as deleting the selection", () => {
    const { store, a, b, c, d } = buildAt3();
    const before = store.getState().flow;

    act(store, (s) => s.deleteNodes([b]));

    expect(store.getState().flow.nodes.map((node) => node.id)).toEqual([a, c, d]);
    expect(store.getState().flow.wires).toEqual([then(a, d)]);

    act(store, (s) => s.undo());

    expect(store.getState().flow).toEqual(before);
  });

  it("deletes several selected nodes as one command and one undo restores them all", () => {
    const { store, a, b, c, d } = buildAt3();
    act(store, (s) => s.select([a, b]));
    const before = store.getState().flow;
    const depth = store.getState().undoStack.length;

    act(store, (s) => s.deleteSelection());

    expect(store.getState().flow.nodes.map((node) => node.id)).toEqual([c, d]);
    expect(store.getState().flow.wires).toEqual([]);
    expect(store.getState().undoStack).toHaveLength(depth + 1);
    expect(store.getState().selection).toEqual([]);

    act(store, (s) => s.undo());

    expect(store.getState().flow).toEqual(before);
  });

  it("records nothing when the selection is empty or no ids are given", () => {
    const { store } = buildAt3();
    act(store, (s) => s.select([]));
    const depth = store.getState().undoStack.length;

    act(store, (s) => s.deleteSelection());
    act(store, (s) => s.deleteNodes([]));

    expect(store.getState().undoStack).toHaveLength(depth);
  });
});

const guarded = () => {
  const store = createCanvasStore({ ready: false });
  store
    .getState()
    .load(
      flow(
        [trigger("T"), agent("P"), hardstop("H"), output("O")],
        [thenWire("T", "P"), thenWire("P", "H"), thenWire("H", "O")],
      ),
    );
  return store;
};

const refuseSelfLoop = (s: ReturnType<Store["getState"]>) =>
  s.connect(end("P", "out"), end("P", "in"));

describe("deleting a hard stop", () => {
  it("starts with no message", () => {
    expect(createCanvasStore().getState().message).toBeNull();
  });

  it("deletes a hard stop by id with its wires, as one undoable step and no message", () => {
    const store = guarded();
    const before = store.getState().flow;

    act(store, (s) => s.deleteNodes(["H"]));

    const after = store.getState();
    expect(after.flow.nodes.map((node) => node.id)).toEqual(["T", "P", "O"]);
    expect(after.flow.wires).toEqual([then("T", "P")]);
    expect(after.message).toBeNull();
    expect(after.undoStack).toHaveLength(1);

    act(store, (s) => s.undo());
    expect(store.getState().flow).toEqual(before);
  });

  it("deletes a hard stop with the rest of a mixed selection as one undoable command", () => {
    const store = guarded();
    const before = store.getState().flow;
    act(store, (s) => s.select(["P", "H"]));

    act(store, (s) => s.deleteSelection());

    expect(store.getState().flow.nodes.map((node) => node.id)).toEqual(["T", "O"]);
    expect(store.getState().undoStack).toHaveLength(1);
    act(store, (s) => s.undo());
    expect(store.getState().flow).toEqual(before);
  });

  it("clears a refusal message on the next successful edit", () => {
    const store = guarded();
    act(store, refuseSelfLoop);
    expect(store.getState().message).not.toBeNull();

    act(store, (s) => s.drop("agent", { x: 0, y: 300 }));

    expect(store.getState().message).toBeNull();
  });

  it("clears a refusal message when the selection changes", () => {
    const store = guarded();
    act(store, refuseSelfLoop);

    act(store, (s) => s.select(["P"]));

    expect(store.getState().message).toBeNull();
  });
});

describe("node menu", () => {
  it("starts closed", () => {
    expect(createCanvasStore().getState().menu).toBeNull();
  });

  it("opens on a node at a point and closes again", () => {
    const store = guarded();

    store.getState().openNodeMenu("P", { x: 10, y: 20 });

    expect(store.getState().menu).toEqual({ nodeId: "P", x: 10, y: 20 });

    store.getState().closeNodeMenu();

    expect(store.getState().menu).toBeNull();
  });

  it("closes when the selection changes", () => {
    const store = guarded();
    store.getState().openNodeMenu("P", { x: 10, y: 20 });

    store.getState().select(["T"]);

    expect(store.getState().menu).toBeNull();
  });

  it.each([
    ["another node", "P"],
    ["the hard stop", "H"],
  ])("closes when %s is deleted", (_name, id) => {
    const store = guarded();
    store.getState().openNodeMenu(id, { x: 10, y: 20 });

    act(store, (s) => s.deleteNodes([id]));

    expect(store.getState().menu).toBeNull();
  });

  it("records nothing when its Delete names a node an undo removed", () => {
    const store = guarded();
    act(store, (s) => s.drop("agent", { x: 0, y: 0 }));
    const dropped = store.getState().flow.nodes.at(-1)?.id ?? "";
    store.getState().openNodeMenu(dropped, { x: 10, y: 20 });
    act(store, (s) => s.undo());
    const { flow: before, undoStack, redoStack } = store.getState();

    act(store, (s) => s.deleteNodes([dropped]));

    expect(store.getState().flow).toBe(before);
    expect(store.getState().undoStack).toEqual(undoStack);
    expect(store.getState().redoStack).toEqual(redoStack);
    expect(store.getState().redoStack).toHaveLength(1);
    expect(store.getState().message).toBeNull();
  });
});

describe("move", () => {
  it("keeps live drag positions out of the flow and records one move on drag end", () => {
    const store = createCanvasStore();
    act(store, (s) => s.drop("agent", { x: 0, y: 0 }));
    const before = store.getState().flow;

    act(store, (s) => s.dragTo("agent-1", { x: 50, y: 60 }));

    expect(store.getState().flow).toBe(before);
    expect(store.getState().dragPositions).toEqual({ "agent-1": { x: 50, y: 60 } });

    act(store, (s) => s.endDrag(["agent-1"]));

    expect(store.getState().undoStack).toHaveLength(2);
    expect(store.getState().flow.nodes[0]?.position).toEqual({ x: 50, y: 60 });
    expect(store.getState().dragPositions).toEqual({});

    act(store, (s) => s.undo());

    expect(store.getState().flow.nodes[0]?.position).toEqual({ x: 0, y: 0 });
  });

  it("records one move for nodes dragged together and leaves undragged ids alone", () => {
    const store = createCanvasStore();
    act(store, (s) => s.drop("agent", { x: 0, y: 0 }));
    act(store, (s) => s.drop("gate", { x: 0, y: 100 }));
    act(store, (s) => s.drop("gate", { x: 200, y: 0 }));
    const before = store.getState().flow;

    act(store, (s) => s.dragTo("agent-1", { x: 10, y: 50 }));
    act(store, (s) => s.dragTo("gate-1", { x: 110, y: 50 }));
    act(store, (s) => s.endDrag(["agent-1", "gate-1", "gate-2"]));

    expect(store.getState().undoStack).toHaveLength(4);
    expect(store.getState().flow.nodes.map((node) => node.position)).toEqual([
      { x: 10, y: 50 },
      { x: 110, y: 50 },
      { x: 200, y: 0 },
    ]);

    act(store, (s) => s.undo());

    expect(store.getState().flow).toEqual(before);
  });

  it("records nothing when the drag ends where it started", () => {
    const store = createCanvasStore();
    act(store, (s) => s.drop("agent", { x: 10, y: 10 }));

    act(store, (s) => s.endDrag(["agent-1"]));
    act(store, (s) => s.dragTo("agent-1", { x: 10, y: 10 }));
    act(store, (s) => s.endDrag(["agent-1"]));

    expect(store.getState().undoStack).toHaveLength(1);
    expect(store.getState().dragPositions).toEqual({});
  });
});

describe("undo and redo", () => {
  it("redo puts the same command back and replays it with the same ids", () => {
    const store = createCanvasStore();
    act(store, (s) => s.drop("agent", { x: 0, y: 0 }));
    const command = store.getState().undoStack.at(-1);
    const after = store.getState().flow;

    act(store, (s) => s.undo());

    expect(store.getState().flow.nodes).toEqual([]);
    expect(store.getState().undoStack).toEqual([]);
    expect(store.getState().redoStack.at(-1)).toBe(command);

    act(store, (s) => s.redo());

    expect(store.getState().undoStack.at(-1)).toBe(command);
    expect(store.getState().redoStack).toEqual([]);
    expect(store.getState().flow).toEqual(after);
  });

  it("undoes several commands newest first and redoes them oldest first", () => {
    const store = createCanvasStore();
    const flows = [store.getState().flow];
    act(store, (s) => s.drop("agent", { x: 0, y: 0 }));
    flows.push(store.getState().flow);
    act(store, (s) => s.drop("gate", { x: 200, y: 0 }));
    flows.push(store.getState().flow);
    act(store, (s) => s.connect(end("agent-1", "out"), end("gate-1", "in")));
    flows.push(store.getState().flow);

    for (const expected of [flows[2], flows[1], flows[0]]) {
      act(store, (s) => s.undo());
      expect(store.getState().flow).toEqual(expected);
    }
    for (const expected of [flows[1], flows[2], flows[3]]) {
      act(store, (s) => s.redo());
      expect(store.getState().flow).toEqual(expected);
    }
  });

  it("redoes a delete back to the flow it left", () => {
    const { store, b } = buildAt3();
    act(store, (s) => s.deleteNodes([b]));
    const deleted = store.getState().flow;

    act(store, (s) => s.undo());
    act(store, (s) => s.redo());

    expect(store.getState().flow).toEqual(deleted);
  });

  it("clears the redo stack when a new command runs after an undo", () => {
    const store = createCanvasStore();
    act(store, (s) => s.drop("agent", { x: 0, y: 0 }));
    act(store, (s) => s.undo());

    act(store, (s) => s.drop("gate", { x: 0, y: 0 }));

    expect(store.getState().redoStack).toEqual([]);
  });

  it("leaves the state untouched when there is nothing to undo or redo", () => {
    const store = createCanvasStore();
    const before = store.getState();

    act(store, (s) => s.undo());
    expect(store.getState()).toBe(before);

    act(store, (s) => s.redo());
    expect(store.getState()).toBe(before);
  });

  it("drops ids from the selection that an undo removes", () => {
    const store = createCanvasStore();
    act(store, (s) => s.drop("agent", { x: 0, y: 0 }));
    act(store, (s) => s.drop("agent", { x: 100, y: 0 }));
    act(store, (s) => s.select(["agent-1", "agent-2"]));

    act(store, (s) => s.undo());

    expect(store.getState().selection).toEqual(["agent-1"]);
  });

  it("drops ids from the selection that a redo removes", () => {
    const store = createCanvasStore();
    act(store, (s) => s.drop("agent", { x: 0, y: 0 }));
    act(store, (s) => s.drop("agent", { x: 100, y: 0 }));
    act(store, (s) => s.deleteNodes(["agent-2"]));
    act(store, (s) => s.undo());
    act(store, (s) => s.select(["agent-1", "agent-2"]));

    act(store, (s) => s.redo());

    expect(store.getState().selection).toEqual(["agent-1"]);
  });
});

describe("node ids", () => {
  it("drops with the injected id source", () => {
    const nextId = vi.fn((type: NodeType) => `${type}-custom`);
    const store = createCanvasStore({ nextId });
    const empty = store.getState().flow;

    act(store, (s) => s.drop("gate", { x: 0, y: 0 }));

    expect(nextId).toHaveBeenCalledWith("gate", empty);
    expect(store.getState().flow.nodes.map((node) => node.id)).toEqual(["gate-custom"]);
    expect(store.getState().selection).toEqual(["gate-custom"]);
  });

  it("numbers from 1 on an empty flow", () => {
    expect(nextNodeId("agent", flow([], []))).toBe("agent-1");
    expect(nextNodeId("gate", flow([], []))).toBe("gate-1");
  });

  it("skips ids already used, ignoring case", () => {
    expect(nextNodeId("agent", flow([agent("Agent-1")], []))).toBe("agent-2");
    expect(nextNodeId("agent", flow([agent("agent-1"), agent("agent-2")], []))).toBe("agent-3");
  });

  it("takes the lowest free number", () => {
    expect(nextNodeId("agent", flow([agent("agent-2")], []))).toBe("agent-1");
  });

  it("generates ids the node-ids rule accepts", () => {
    const store = createCanvasStore();
    dropFour(store);

    for (const node of store.getState().flow.nodes) expect(node.id).toMatch(nodeIdRule);
  });
});

const savedFlow = () =>
  flow(
    [
      { ...agent("agent-1"), position: { x: 10, y: 20 } },
      { ...agent("gate-1"), position: { x: 300, y: 20 } },
    ],
    [thenWire("agent-1", "gate-1")],
  );

describe("edit gate", () => {
  it("is not ready when created with ready false", () => {
    expect(createCanvasStore({ ready: false }).getState().ready).toBe(false);
  });

  const gated: [string, (state: ReturnType<Store["getState"]>) => unknown][] = [
    ["drop", (s) => s.drop("agent", { x: 0, y: 0 })],
    ["connect", (s) => s.connect(end("agent-1", "out"), end("gate-1", "in"))],
    ["deleteNodes", (s) => s.deleteNodes(["agent-1"])],
    ["dragTo", (s) => s.dragTo("agent-1", { x: 50, y: 50 })],
    ["endDrag", (s) => s.endDrag(["agent-1"])],
    ["updateSession", (s) => s.updateSession({ ...s.flow.session, model: "haiku" })],
    [
      "updateNode",
      (s) =>
        s.updateNode({ ...s.flow.nodes[0], label: "Renamed" } as Parameters<
          typeof s.updateNode
        >[0]),
    ],
    ["undo", (s) => s.undo()],
    ["redo", (s) => s.redo()],
  ];

  const seededNotReady = () => {
    const source = createCanvasStore();
    act(source, (s) => s.drop("agent", { x: 0, y: 0 }));
    act(source, (s) => s.drop("gate", { x: 200, y: 0 }));
    act(source, (s) => s.drop("agent", { x: 400, y: 0 }));
    act(source, (s) => s.undo());
    const { flow: seeded, undoStack, redoStack } = source.getState();
    const store = createCanvasStore({ ready: false });
    store.setState({
      flow: seeded,
      undoStack,
      redoStack,
      selection: ["agent-1", "gate-1"],
      dragPositions: { "agent-1": { x: 50, y: 50 } },
    });
    return store;
  };

  it.each(gated)("ignores %s until ready", (_name, action) => {
    const store = seededNotReady();
    const before = store.getState();

    action(store.getState());

    expect(store.getState()).toBe(before);
    expect(store.getState().flow).toBe(before.flow);
    expect(store.getState().undoStack).toBe(before.undoStack);
  });

  it("records nothing on a fresh store that is not ready", () => {
    const store = createCanvasStore({ ready: false });

    store.getState().drop("agent", { x: 0, y: 0 });

    expect(store.getState().flow).toEqual(newCanvasFlow());
    expect(store.getState().undoStack).toEqual([]);
  });
});

describe("load", () => {
  it("sets the flow and the saved flow and makes the store ready", () => {
    const store = createCanvasStore({ ready: false });
    const loaded = savedFlow();

    store.getState().load(loaded);

    const state = store.getState();
    expect(state.ready).toBe(true);
    expect(state.flow).toEqual(loaded);
    expect(state.saved).toEqual(loaded);
    expectValid(state.flow);
  });

  it("runs parseFlow, so a loop saved without a cap gets the default cap", () => {
    const store = createCanvasStore({ ready: false });
    const input = {
      ...newCanvasFlow(),
      nodes: [
        {
          id: "loop-1",
          type: "loop",
          label: "Loop",
          position: { x: 0, y: 0 },
          settings: { condition: "done" },
        },
      ],
    };

    store.getState().load(input);

    expect(store.getState().flow.nodes[0]?.settings).toEqual({ condition: "done", cap: 3 });
  });

  it("clears undo, redo, selection and drag positions", () => {
    const store = createCanvasStore();
    act(store, (s) => s.drop("agent", { x: 0, y: 0 }));
    act(store, (s) => s.drop("agent", { x: 100, y: 0 }));
    act(store, (s) => s.undo());
    act(store, (s) => s.select(["agent-1"]));
    act(store, (s) => s.dragTo("agent-1", { x: 40, y: 40 }));

    store.getState().load(savedFlow());

    const state = store.getState();
    expect(state.undoStack).toEqual([]);
    expect(state.redoStack).toEqual([]);
    expect(state.selection).toEqual([]);
    expect(state.dragPositions).toEqual({});
  });

  it("throws on an input that is not a flow and leaves the store not ready and unchanged", () => {
    const store = createCanvasStore({ ready: false });
    const before = store.getState();

    expect(() => store.getState().load({ nodes: "none" })).toThrow();

    expect(store.getState()).toBe(before);
    expect(store.getState().ready).toBe(false);
  });

  it("accepts edits once loaded", () => {
    const store = createCanvasStore({ ready: false });
    store.getState().load(savedFlow());

    act(store, (s) => s.drop("agent", { x: 0, y: 300 }));

    expect(store.getState().flow.nodes.map((node) => node.id)).toEqual([
      "agent-1",
      "gate-1",
      "agent-2",
    ]);
    expect(store.getState().undoStack).toHaveLength(1);
  });
});

describe("selectDirty", () => {
  const loadedStore = () => {
    const store = createCanvasStore({ ready: false });
    store.getState().load(savedFlow());
    return store;
  };

  it("is clean right after a load", () => {
    expect(selectDirty(loadedStore().getState())).toBe(false);
  });

  it("is dirty after a drop and clean again after undo back to the loaded flow", () => {
    const store = loadedStore();

    act(store, (s) => s.drop("agent", { x: 0, y: 300 }));
    expect(selectDirty(store.getState())).toBe(true);

    act(store, (s) => s.undo());
    expect(selectDirty(store.getState())).toBe(false);
  });

  it("stays clean when only the selection changes", () => {
    const store = loadedStore();

    act(store, (s) => s.select(["agent-1", "gate-1"]));
    act(store, (s) => s.select([]));

    expect(selectDirty(store.getState())).toBe(false);
  });
});

describe("markSaved", () => {
  it("sets the saved flow, so the current flow reads clean", () => {
    const store = createCanvasStore();
    act(store, (s) => s.drop("agent", { x: 0, y: 0 }));
    const snapshot = store.getState().flow;
    expect(selectDirty(store.getState())).toBe(true);

    store.getState().markSaved(snapshot);

    expect(store.getState().saved).toEqual(snapshot);
    expect(selectDirty(store.getState())).toBe(false);
  });

  it("stays dirty when an edit happened after the snapshot was taken", () => {
    const store = createCanvasStore();
    act(store, (s) => s.drop("agent", { x: 0, y: 0 }));
    const snapshot = store.getState().flow;
    act(store, (s) => s.drop("gate", { x: 200, y: 0 }));

    store.getState().markSaved(snapshot);

    expect(store.getState().saved).toEqual(snapshot);
    expect(selectDirty(store.getState())).toBe(true);
  });
});

describe("updateSession", () => {
  const edited: Session = {
    name: "main",
    buildConfig: { repo: "/tmp/x", variables: [] },
    model: "haiku",
    allowedTools: ["Read"],
    permissionMode: "default",
    connectors: [],
  };

  it("replaces the session as an undoable edit that makes the canvas dirty", () => {
    const store = createCanvasStore();
    const start = store.getState().flow.session;

    act(store, (s) => s.updateSession(edited));

    expect(store.getState().flow.session).toEqual(edited);
    expect(store.getState().undoStack).toHaveLength(1);
    expect(selectDirty(store.getState())).toBe(true);

    act(store, (s) => s.undo());

    expect(store.getState().flow.session).toEqual(start);
    expect(selectDirty(store.getState())).toBe(false);

    act(store, (s) => s.redo());

    expect(store.getState().flow.session).toEqual(edited);
  });
});

describe("newCanvasFlow", () => {
  it("names no repository and declares no variables yet, and has no frame", () => {
    const { session } = newCanvasFlow();

    expect(session.buildConfig).toEqual({ variables: [] });
    expect(Object.hasOwn(session, "frame")).toBe(false);
  });

  it("is refused at build for its repository, its Start and its Stop", () => {
    expect(validate(newCanvasFlow()).map(({ rule }) => rule)).toEqual(
      expect.arrayContaining(["repo-required", "one-start", "stop-required"]),
    );
    expect(validate(newCanvasFlow())).toHaveLength(3);
    expect(validate(newCanvasFlow())).toContainEqual(
      expect.objectContaining({ rule: "repo-required", field: "buildConfig.repo" }),
    );
  });
});

describe("the Build configuration", () => {
  const configOf = (store: Store) => store.getState().flow.session.buildConfig;

  const undoable = (store: Store, edit: (state: ReturnType<Store["getState"]>) => void) => {
    const before = configOf(store);
    act(store, edit);
    const after = configOf(store);
    expect(after).not.toEqual(before);
    expect(store.getState().undoStack).toHaveLength(1);
    expect(selectDirty(store.getState())).toBe(true);
    act(store, (s) => s.undo());
    expect(configOf(store)).toEqual(before);
    act(store, (s) => s.redo());
    expect(configOf(store)).toEqual(after);
    return after;
  };

  it("sets the repository as one undoable edit", () => {
    expect(undoable(createCanvasStore(), (s) => s.setRepo("/code/shop"))).toEqual({
      repo: "/code/shop",
      variables: [],
    });
  });

  const withConfig = () => {
    const store = createCanvasStore();
    const start = newCanvasFlow();
    store.getState().load({
      ...start,
      session: {
        ...start.session,
        buildConfig: {
          repo: "/a",
          base: "dev",
          variables: [{ name: "topic", kind: "text" }],
          buildModel: "haiku",
        },
      },
    });
    return store;
  };

  it("drops the base when the repository changes, keeping the variables and build model", () => {
    const store = withConfig();

    expect(undoable(store, (s) => s.setRepo("/b"))).toEqual({
      repo: "/b",
      variables: [{ name: "topic", kind: "text" }],
      buildModel: "haiku",
    });
  });

  it("keeps the base when the same repository is set again", () => {
    const store = withConfig();

    act(store, (s) => s.setRepo("/a"));

    expect(configOf(store)).toMatchObject({ repo: "/a", base: "dev" });
  });

  it("sets the base branch as one undoable edit, and an empty base leaves it to the repository", () => {
    const store = createCanvasStore();

    expect(undoable(store, (s) => s.setBase("dev"))).toEqual({ base: "dev", variables: [] });

    act(store, (s) => s.setBase(""));
    expect(configOf(store)).toEqual({ variables: [] });
  });

  it("changes only the base branch, keeping the repository, variables and build model", () => {
    const store = withConfig();

    expect(undoable(store, (s) => s.setBase("main"))).toEqual({
      repo: "/a",
      base: "main",
      variables: [{ name: "topic", kind: "text" }],
      buildModel: "haiku",
    });
  });

  it("clears the base branch, keeping the repository, variables and build model", () => {
    const store = withConfig();

    expect(undoable(store, (s) => s.setBase(""))).toEqual({
      repo: "/a",
      variables: [{ name: "topic", kind: "text" }],
      buildModel: "haiku",
    });
  });

  it("adds a text variable with a name not yet taken, as one undoable edit", () => {
    const store = createCanvasStore();

    expect(undoable(store, (s) => s.addVariable())).toEqual({
      variables: [{ name: "variable", kind: "text" }],
    });

    act(store, (s) => s.addVariable());
    expect(configOf(store).variables.map(({ name }) => name)).toEqual(["variable", "variable-2"]);
  });

  it("edits a variable in place as one undoable edit, keeping the others and their order", () => {
    const store = createCanvasStore();
    act(store, (s) => s.addVariable());
    act(store, (s) => s.addVariable());
    store.getState().markSaved(store.getState().flow);
    store.setState({ undoStack: [], redoStack: [] });

    expect(
      undoable(store, (s) => s.updateVariable(0, { name: "deep", kind: "yesno", default: true })),
    ).toEqual({
      variables: [
        { name: "deep", kind: "yesno", default: true },
        { name: "variable-2", kind: "text" },
      ],
    });
  });

  it("removes a variable as one undoable edit", () => {
    const store = createCanvasStore();
    act(store, (s) => s.addVariable());
    act(store, (s) => s.addVariable());
    store.getState().markSaved(store.getState().flow);
    store.setState({ undoStack: [], redoStack: [] });

    expect(undoable(store, (s) => s.removeVariable(0))).toEqual({
      variables: [{ name: "variable-2", kind: "text" }],
    });
  });

  it("moves an imported old-shape flow into the Build configuration", () => {
    const store = createCanvasStore({ ready: false });
    const old = {
      nodes: [
        {
          id: "T",
          type: "trigger",
          label: "Start",
          position: { x: 0, y: 0 },
          settings: { inputs: ["ticket"], flags: { deep: true } },
        },
        {
          id: "B",
          type: "branch",
          label: "Deep?",
          position: { x: 200, y: 0 },
          settings: { flag: "deep" },
        },
      ],
      wires: [],
      session: {
        name: "main",
        workingFolder: { kind: "worktree", repo: "/code/shop", branch: "dev" },
        model: "sonnet",
        allowedTools: [],
        permissionMode: "default",
        connectors: [],
      },
    };

    store.getState().load(old);

    const { session, nodes } = store.getState().flow;
    expect(session).not.toHaveProperty("workingFolder");
    expect(session.buildConfig).toEqual({
      repo: "/code/shop",
      base: "dev",
      variables: expect.arrayContaining([
        { name: "ticket", kind: "text" },
        { name: "deep", kind: "yesno", default: true },
      ]),
    });
    expect(nodes.map((node) => node.settings)).toEqual([{}, { variable: "deep" }]);
  });
});

describe("highlight", () => {
  const loadedStore = () => {
    const store = createCanvasStore({ ready: false });
    store.getState().load(savedFlow());
    return store;
  };

  it("starts with nothing highlighted", () => {
    expect(createCanvasStore().getState().highlighted).toBeNull();
  });

  it("highlights a node without selecting it, recording a command or making the canvas dirty", () => {
    const store = loadedStore();
    const before = store.getState();

    store.getState().highlight("agent-1");

    const state = store.getState();
    expect(state.highlighted).toBe("agent-1");
    expect(state.selection).toEqual([]);
    expect(state.undoStack).toBe(before.undoStack);
    expect(state.redoStack).toBe(before.redoStack);
    expect(state.flow).toBe(before.flow);
    expect(selectDirty(state)).toBe(false);
  });

  it("clears the highlight with null", () => {
    const store = loadedStore();
    store.getState().highlight("agent-1");

    store.getState().highlight(null);

    expect(store.getState().highlighted).toBeNull();
  });
});

const everyType = NodeType.options;

describe("every node type", () => {
  it.each(everyType)("isNodeType accepts %s", (type) => {
    expect(isNodeType(type)).toBe(true);
  });

  it.each(["session", "", "Prompt"])("isNodeType refuses %j", (value) => {
    expect(isNodeType(value)).toBe(false);
  });

  it.each(everyType)("drops %s with its core defaults", (type) => {
    const store = createCanvasStore();

    store.getState().drop(type, { x: 40, y: 40 });

    const current = store.getState().flow;
    expect(current.nodes).toEqual([
      {
        id: `${type}-1`,
        type,
        label: nodeDefaults[type].label,
        position: { x: 40, y: 40 },
        settings: nodeDefaults[type].settings,
      },
    ]);
    expect(parseFlow(current)).toEqual(current);
  });
});

describe("connect beside an invalid node", () => {
  const withLoneFork = () => {
    const store = createCanvasStore();
    store.getState().drop("agent", { x: 0, y: 0 });
    store.getState().drop("gate", { x: 300, y: 0 });
    store.getState().drop("fork", { x: 0, y: 300 });
    return store;
  };

  it("accepts a valid wire while a lone fork is on the canvas", () => {
    const store = withLoneFork();

    expect(store.getState().connect(end("agent-1", "out"), end("gate-1", "in"))).toBe(true);
    expect(store.getState().flow.wires).toEqual([then("agent-1", "gate-1")]);
  });

  it("still refuses a wire whose own errors are new", () => {
    const store = withLoneFork();
    const before = store.getState();

    expect(store.getState().connect(end("agent-1", "in"), end("gate-1", "in"))).toBe(false);
    expect(store.getState().flow).toEqual(before.flow);
    expect(store.getState().undoStack).toEqual(before.undoStack);
  });

  it.each(["gate", "branch"] as const)(
    "connects Start to a freshly dropped %s that is not filled in yet",
    (type) => {
      const store = createCanvasStore();
      store.getState().drop("trigger", { x: 0, y: 0 });
      store.getState().drop("output", { x: 400, y: 0 });
      store.getState().connect(end("trigger-1", "out"), end("output-1", "in"));
      store.getState().drop(type, { x: 200, y: 200 });

      expect(store.getState().connect(end("trigger-1", "out"), end(`${type}-1`, "in"))).toBe(true);
      expect(store.getState().flow.wires).toContainEqual(then("trigger-1", `${type}-1`));
    },
  );

  it("wires a parallel section one wire at a time into a valid flow", () => {
    const store = createCanvasStore();
    store.getState().drop("fork", { x: 0, y: 0 });
    store.getState().drop("agent", { x: 200, y: 0 });
    store.getState().drop("agent", { x: 200, y: 200 });
    store.getState().drop("join", { x: 500, y: 0 });

    expect(store.getState().connect(end("fork-1", "out"), end("agent-1", "in"))).toBe(true);
    expect(store.getState().connect(end("fork-1", "out"), end("agent-2", "in"))).toBe(true);
    expect(store.getState().connect(end("agent-1", "out"), end("join-1", "in"))).toBe(true);
    expect(store.getState().connect(end("agent-2", "out"), end("join-1", "in"))).toBe(true);
    expect(store.getState().flow.wires).toHaveLength(4);
    expect(structural(store.getState().flow)).toEqual([]);
  });
});

describe("selectCanvasEmpty", () => {
  it("is true for a new store and false after one drop", () => {
    const store = createCanvasStore();
    expect(selectCanvasEmpty(store.getState())).toBe(true);

    store.getState().drop("agent", { x: 0, y: 0 });

    expect(selectCanvasEmpty(store.getState())).toBe(false);
  });

  it("is false when the canvas holds only a note", () => {
    const store = createCanvasStore();

    store.getState().drop("note", { x: 0, y: 0 });

    expect(store.getState().flow.nodes).toEqual([]);
    expect(selectCanvasEmpty(store.getState())).toBe(false);
  });
});

const promptWidth = nodeLook("agent").box.width;
const boxOf = (node: Flow["nodes"][number]) => ({ ...node.position, ...nodeLook(node.type).box });
const overlaps = (a: ReturnType<typeof boxOf>, b: ReturnType<typeof boxOf>) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

describe("placeNode", () => {
  it("returns the request on an empty flow", () => {
    expect(placeNode(newCanvasFlow(), "agent", { x: 100, y: 100 })).toEqual({ x: 100, y: 100 });
  });

  it("moves a request that overlaps a node to that node's right edge plus 48", () => {
    const current = flow([{ ...agent("p"), position: { x: 100, y: 100 } }], []);

    expect(placeNode(current, "gate", { x: 120, y: 110 })).toEqual({
      x: 100 + promptWidth + 48,
      y: 110,
    });
  });

  it("clears two nodes in a row", () => {
    const current = flow(
      [
        { ...agent("p"), position: { x: 100, y: 100 } },
        { ...agent("q"), position: { x: 100 + promptWidth + 48, y: 100 } },
      ],
      [],
    );

    expect(placeNode(current, "agent", { x: 100, y: 100 })).toEqual({
      x: 100 + 2 * (promptWidth + 48),
      y: 100,
    });
  });

  it("keeps two drops at the same point from overlapping", () => {
    const store = createCanvasStore();

    store.getState().drop("agent", { x: 50, y: 50 });
    store.getState().drop("agent", { x: 50, y: 50 });

    const [first, second] = store.getState().flow.nodes;
    if (first === undefined || second === undefined) throw new Error("expected two nodes");
    expect(overlaps(boxOf(first), boxOf(second))).toBe(false);
  });
});

describe("placement beside a wide node", () => {
  const long = "Review every changed file against the plan and list each gap";
  const wide = () =>
    flow(
      [
        { ...agent("A"), label: long, position: { x: 100, y: 100 } },
        { ...agent("P"), position: { x: 100, y: 300 } },
      ],
      [],
    );
  const wideRight = () => 100 + nodeWidth({ type: "agent", label: long });

  it("adds a node right of a 60-character Agent's width", () => {
    const store = createCanvasStore();
    store.getState().load(wide());
    store.getState().select(["A"]);

    store.getState().addNext("gate");

    expect(store.getState().flow.nodes.at(-1)?.position).toEqual({
      x: wideRight() + 48,
      y: 100,
    });
  });

  it("counts a drop on only the widened part of a wide node as overlapping", () => {
    expect(placeNode(wide(), "agent", { x: 100 + promptWidth + 10, y: 100 })).toEqual({
      x: wideRight() + 48,
      y: 100,
    });
  });

  it("moves no other node when a placed Agent is renamed to 60 characters", () => {
    const store = createCanvasStore();
    store.getState().load(
      flow(
        [
          { ...agent("A"), position: { x: 100, y: 100 } },
          { ...agent("B"), position: { x: 100 + promptWidth + 48, y: 100 } },
          { ...agent("C"), position: { x: 100, y: 200 } },
        ],
        [],
      ),
    );
    const before = store.getState().flow.nodes.filter((node) => node.id !== "A");

    store.getState().startRename("A");
    store.getState().rename(long);

    expect(store.getState().flow.nodes.find((node) => node.id === "A")?.label).toBe(long);
    expect(store.getState().flow.nodes.filter((node) => node.id !== "A")).toEqual(before);
  });
});

describe("addNext", () => {
  it("adds right of the one selected node at its y", () => {
    const store = createCanvasStore();
    store.getState().drop("agent", { x: 100, y: 100 });

    store.getState().addNext("gate");

    expect(store.getState().flow.nodes[1]?.position).toEqual({
      x: 100 + promptWidth + 48,
      y: 100,
    });
    expect(store.getState().selection).toEqual(["gate-1"]);
  });

  it("adds right of the rightmost node when nothing is selected", () => {
    const store = createCanvasStore();
    store.getState().drop("agent", { x: 100, y: 100 });
    store.getState().drop("agent", { x: 500, y: 40 });
    store.getState().select([]);

    store.getState().addNext("gate");

    expect(store.getState().flow.nodes[2]?.position).toEqual({
      x: 500 + promptWidth + 48,
      y: 40,
    });
  });

  it("adds at (80, 80) on an empty canvas, as one undoable command", () => {
    const store = createCanvasStore();

    store.getState().addNext("agent");

    expect(store.getState().flow.nodes.map((node) => node.position)).toEqual([{ x: 80, y: 80 }]);
    expect(store.getState().undoStack).toHaveLength(1);

    store.getState().undo();

    expect(store.getState().flow).toEqual(newCanvasFlow());
  });
});

describe("selectNodeIssues", () => {
  it("maps a lone fork to its parallel-section message without the node id", () => {
    const current = flow([fork("fork-1")], []);
    const message = validate(current).find((error) => error.rule === "parallel-section")?.message;

    expect(message).toBe("fork-1 has 0 branches; a parallel start needs two or more.");
    expect(selectNodeIssues(current)).toEqual({
      "fork-1": ["Has 0 branches; a parallel start needs two or more."],
    });
  });

  it("drops the node id and its type from a For each reason", () => {
    const current = flow([forEach("foreach-1")], []);

    expect(selectNodeIssues(current)).toEqual({
      "foreach-1": ["Has no agent in its body."],
    });
  });

  it("has no entry for a valid prompt", () => {
    expect(selectNodeIssues(flow([agent("agent-1")], []))).toEqual({});
  });

  it("maps an agent with empty instructions to its reason", () => {
    const current = flow([agent("agent-1", { settings: { instructions: "" } })], []);

    expect(selectNodeIssues(current)).toEqual({ "agent-1": ["Write what the agent should do."] });
  });

  describe("reads only the main flow", () => {
    const blankAgent = agent("agent-1", { settings: { instructions: "" } });
    const nodes = [trigger("start"), agent("p1"), output("stop"), blankAgent];

    it("has no entry for an agent with empty instructions off it", () => {
      const current = flow(nodes, [thenWire("start", "p1"), thenWire("p1", "stop")]);

      expect(selectNodeIssues(current)).toEqual({});
    });

    it("maps the same agent to its reason once it is on it", () => {
      const current = flow(nodes, [
        thenWire("start", "p1"),
        thenWire("p1", "agent-1"),
        thenWire("agent-1", "stop"),
      ]);

      expect(selectNodeIssues(current)).toEqual({ "agent-1": ["Write what the agent should do."] });
    });
  });

  it("returns the same map for the same flow", () => {
    const current = flow([fork("fork-1")], []);

    expect(selectNodeIssues(current)).toBe(selectNodeIssues(current));
  });
});

describe("updateNode", () => {
  it("edits a node's settings as an undoable step the canvas sees", () => {
    const store = createCanvasStore();
    act(store, (s) => s.drop("gate", { x: 0, y: 0 }));
    const [gateNode] = store.getState().flow.nodes;
    if (gateNode?.type !== "gate") throw new Error("expected a gate");
    const edited = {
      ...gateNode,
      label: "Check",
      settings: { shown: "The plan", skippable: true },
    };

    act(store, (s) => s.updateNode(edited));

    expect(store.getState().flow.nodes).toEqual([edited]);
    expect(store.getState().selection).toEqual([gateNode.id]);
    expect(store.getState().undoStack).toHaveLength(2);

    act(store, (s) => s.undo());
    expect(store.getState().flow.nodes).toEqual([gateNode]);

    act(store, (s) => s.redo());
    expect(store.getState().flow.nodes).toEqual([edited]);
  });

  it("records nothing when the node is unchanged or gone", () => {
    const store = createCanvasStore();
    act(store, (s) => s.drop("gate", { x: 0, y: 0 }));
    const [gateNode] = store.getState().flow.nodes;
    if (gateNode === undefined) throw new Error("expected a gate");
    const before = store.getState().flow;

    act(store, (s) => s.updateNode(structuredClone(gateNode)));
    act(store, (s) => s.updateNode({ ...gateNode, id: "missing" }));

    expect(store.getState().flow).toBe(before);
    expect(store.getState().undoStack).toHaveLength(1);
  });
});

describe("selectSelectedNode", () => {
  const two = () => flow([agent("a"), agent("b")], []);

  it("is the one selected node", () => {
    expect(selectSelectedNode({ flow: two(), selection: ["b"] })?.id).toBe("b");
  });

  it.each([[[]], [["a", "b"]], [["gone"]]])("is null for selection %j", (selection) => {
    expect(selectSelectedNode({ flow: two(), selection })).toBeNull();
  });
});

describe("selectFieldIssues", () => {
  it("maps each field the validator names to its reason, for that node only", () => {
    const current = flow(
      [
        loop("loop-1", { settings: { cap: 0, onCap: undefined } }),
        agent("agent-1", { settings: { instructions: "" } }),
      ],
      [],
    );

    expect(selectFieldIssues(current, "loop-1")).toEqual({
      cap: "Loop cap 0 is not a whole number of at least 1.",
      onCap: "Loop has no action for when its cap is reached.",
    });
    expect(selectFieldIssues(current, "agent-1")).toEqual({
      instructions: "Write what the agent should do.",
    });
  });

  it("is empty for a node with no field-level issue", () => {
    expect(selectFieldIssues(flow([fork("fork-1")], []), "fork-1")).toEqual({});
  });
});

describe("a node's shown label", () => {
  const unnamedAgent = { ...agent("A"), label: "" };

  it.each([
    ["agent", "", "Agent"],
    ["agent", "   ", "Agent"],
    ["hardstop", "", "Hard stop"],
    ["foreach", "", "For each"],
  ] as const)("labelFor names a %s labelled %j by its type, %j", (type, label, shown) => {
    expect(labelFor({ type, label })).toBe(shown);
  });

  it("labelFor keeps a label that has text", () => {
    expect(labelFor({ type: "agent", label: "Review" })).toBe("Review");
  });

  it("labelFor names no node at all Build", () => {
    expect(labelFor(undefined)).toBe("Build");
  });

  it("nodeLabel names no node id Build", () => {
    expect(nodeLabel(flow([unnamedAgent], []).nodes, undefined)).toBe("Build");
  });

  it("nodeLabel falls back to the raw id of a node that is not there", () => {
    expect(nodeLabel(flow([unnamedAgent], []).nodes, "missing-id")).toBe("missing-id");
  });

  it("nodeLabel names an empty-labelled Agent by its type", () => {
    expect(nodeLabel(flow([unnamedAgent], []).nodes, "A")).toBe("Agent");
  });

  it("names an empty-labelled Agent in a connection refusal", () => {
    const store = createCanvasStore();
    store.getState().load(flow([unnamedAgent], []));

    expect(store.getState().connect(end("A", "out"), end("A", "in"))).toBe(false);

    expect(store.getState().message).toMatch(/^Can't connect Agent to Agent: /);
  });

  it("names an empty-labelled Loop in a paste refusal", () => {
    const store = createCanvasStore();
    store.getState().load(
      flow(
        [
          { ...loop("L"), label: "" },
          { ...trigger("T"), position: { x: 400, y: 0 } },
        ],
        [],
      ),
    );
    store.getState().select(["T"]);
    store.getState().copy();
    store.getState().select(["L"]);

    store.getState().paste();

    expect(store.getState().message).toMatch(/^Can't paste into Loop: /);
  });
});

describe("agent edits", () => {
  const agentNode = (id: string): Node => {
    const [node] = flow([agent(id)], []).nodes;
    if (node === undefined) throw new Error("expected a node");
    return node;
  };
  const agentAdds = (store: Store, id: string) =>
    act(store, (s) => s.applyAgent(addNode(agentNode(id))));
  const ids = (store: Store) => store.getState().flow.nodes.map(({ id }) => id);

  it("amends one undo entry per ask, and one undo reverts every edit in it", () => {
    const store = createCanvasStore();
    const before = store.getState().flow;

    expect(agentAdds(store, "a")).toBe(true);
    expect(store.getState().undoStack).toHaveLength(1);
    expect(agentAdds(store, "b")).toBe(true);
    expect(agentAdds(store, "c")).toBe(true);

    expect(ids(store)).toEqual(["a", "b", "c"]);
    expect(store.getState().undoStack).toHaveLength(1);
    act(store, (s) => s.undo());
    expect(store.getState().flow).toEqual(before);
    expect(store.getState().undoStack).toEqual([]);
  });

  it("starts a new entry for the next agent edit after the group ends", () => {
    const store = createCanvasStore();
    agentAdds(store, "a");
    agentAdds(store, "b");

    store.getState().endAgentGroup();
    agentAdds(store, "c");

    expect(store.getState().undoStack).toHaveLength(2);
    act(store, (s) => s.undo());
    expect(ids(store)).toEqual(["a", "b"]);
  });

  it("keeps a user edit between agent edits as its own entry, and closes the group", () => {
    const store = createCanvasStore();
    agentAdds(store, "a");

    act(store, (s) => s.updateNode({ ...agentNode("a"), label: "Renamed" }));
    agentAdds(store, "b");

    expect(store.getState().undoStack).toHaveLength(3);
    act(store, (s) => s.undo());
    expect(ids(store)).toEqual(["a"]);
    expect(store.getState().flow.nodes[0]?.label).toBe("Renamed");
    act(store, (s) => s.undo());
    expect(store.getState().flow.nodes[0]?.label).toBe("a");
  });

  it("closes the group on undo", () => {
    const store = createCanvasStore();
    act(store, (s) => s.drop("gate", { x: 0, y: 0 }));
    agentAdds(store, "a");

    act(store, (s) => s.undo());
    agentAdds(store, "b");

    expect(store.getState().undoStack).toHaveLength(2);
    act(store, (s) => s.undo());
    expect(ids(store)).toEqual(["gate-1"]);
  });

  it("closes the group on redo", () => {
    const store = createCanvasStore();
    agentAdds(store, "a");
    store.setState({ redoStack: [addNode(agentNode("redone"))] });

    act(store, (s) => s.redo());
    agentAdds(store, "b");

    expect(store.getState().undoStack).toHaveLength(3);
    act(store, (s) => s.undo());
    expect(ids(store)).toEqual(["a", "redone"]);
  });

  it("closes the group on markSaved", () => {
    const store = createCanvasStore();
    agentAdds(store, "a");

    store.getState().markSaved(store.getState().flow);
    agentAdds(store, "b");

    expect(store.getState().undoStack).toHaveLength(2);
    act(store, (s) => s.undo());
    expect(ids(store)).toEqual(["a"]);
  });

  it("closes the group on load", () => {
    const store = createCanvasStore();
    const loaded = flow([agent("p")], []);
    agentAdds(store, "a");

    store.getState().load(loaded);
    agentAdds(store, "b");
    agentAdds(store, "c");

    expect(store.getState().undoStack).toHaveLength(1);
    act(store, (s) => s.undo());
    expect(store.getState().flow).toEqual(loaded);
  });

  it("clears the redo stack", () => {
    const store = createCanvasStore();
    act(store, (s) => s.drop("gate", { x: 0, y: 0 }));
    act(store, (s) => s.undo());
    expect(store.getState().redoStack).toHaveLength(1);

    agentAdds(store, "a");

    expect(store.getState().redoStack).toEqual([]);
  });

  it("returns false and leaves the flow unchanged while the canvas is not ready", () => {
    const store = createCanvasStore({ ready: false });
    const before = store.getState();

    expect(store.getState().applyAgent(addNode(agentNode("a")))).toBe(false);

    expect(store.getState().flow).toBe(before.flow);
    expect(store.getState().undoStack).toEqual([]);
  });

  describe("variableCommand", () => {
    const variablesOf = (store: Store) => store.getState().flow.session.buildConfig.variables;
    const withTwoVariables = () => {
      const store = createCanvasStore();
      store.getState().load(
        parseFlow({
          ...newCanvasFlow(),
          session: {
            ...newCanvasFlow().session,
            buildConfig: {
              variables: [
                { name: "deep", kind: "text" },
                { name: "ticket", kind: "text" },
              ],
            },
          },
        }),
      );
      return store;
    };

    it("adds a variable that does not exist yet", () => {
      const store = withTwoVariables();

      act(store, (s) => s.applyAgent(s.variableCommand({ name: "new", kind: "yesno" })));

      expect(variablesOf(store)).toEqual([
        { name: "deep", kind: "text" },
        { name: "ticket", kind: "text" },
        { name: "new", kind: "yesno" },
      ]);
    });

    it("updates a variable with the same name in place, and undo restores it", () => {
      const store = withTwoVariables();

      act(store, (s) =>
        s.applyAgent(s.variableCommand({ name: "deep", kind: "yesno", default: true })),
      );

      expect(variablesOf(store)).toEqual([
        { name: "deep", kind: "yesno", default: true },
        { name: "ticket", kind: "text" },
      ]);
      act(store, (s) => s.undo());
      expect(variablesOf(store)).toEqual([
        { name: "deep", kind: "text" },
        { name: "ticket", kind: "text" },
      ]);
    });
  });
});

describe("tidy", () => {
  const defaultCanvas = { width: 1600, height: 1000 };

  const messy = (): Flow => ({
    ...onMainFlow(
      [
        agent("a", { settings: { instructions: "Write the plan." } }),
        fork("F"),
        agent("b1"),
        agent("b2"),
        join("J"),
        loop("L"),
        agent("x", { parent: "L" }),
        { ...agent("c"), label: "Wrap up" },
      ],
      [
        thenWire("a", "F"),
        thenWire("F", "b1"),
        thenWire("F", "b2"),
        thenWire("b1", "J"),
        thenWire("b2", "J"),
        thenWire("J", "x"),
        thenWire("x", "c"),
      ],
    ),
    notes: [{ id: "n1", text: "hi", position: { x: 0, y: 0 }, size: { width: 200, height: 100 } }],
  });

  const longChain = (): Flow => {
    const ids = Array.from({ length: 30 }, (_, index) => `s${index + 1}`);
    return onMainFlow(
      ids.map((id) => agent(id)),
      ids.slice(1).map((id, index) => thenWire(ids[index] ?? "", id)),
    );
  };

  const loaded = (source: Flow) => {
    const store = createCanvasStore();
    store.getState().load(source);
    return store;
  };

  const laidOut = async (source: Flow, size = defaultCanvas) =>
    moveNodes(await tidyMoves(source, size)).do(source);

  const positionsOf = (current: Flow) =>
    Object.fromEntries(current.nodes.map(({ id, position }) => [id, position]));

  it("adds one undo entry, marks the blueprint unsaved, and one undo restores every position", async () => {
    const store = loaded(messy());
    const before = store.getState().flow;

    await store.getState().tidy();

    expect(positionsOf(store.getState().flow)).not.toEqual(positionsOf(before));
    expect(store.getState().undoStack).toHaveLength(1);
    expect(selectDirty(store.getState())).toBe(true);

    store.getState().undo();

    expect(store.getState().flow).toEqual(before);
  });

  it("changes nothing but node positions", async () => {
    const store = loaded(messy());
    const before = store.getState().flow;

    await store.getState().tidy();

    const after = store.getState().flow;
    expect(positionsOf(after)).not.toEqual(positionsOf(before));
    expect(after).toEqual({
      ...before,
      nodes: before.nodes.map((node) => ({ ...node, position: positionsOf(after)[node.id] })),
    });
  });

  it("shows a layout failure on the canvas and changes nothing", async () => {
    const store = loaded(messy());
    const { flow: before, fitSeq } = store.getState();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(tidyMoves).mockRejectedValueOnce(new Error("layout engine crashed"));

    await store.getState().tidy();

    expect(store.getState().message).toBe("Can't tidy the layout: layout engine crashed");
    expect(logged).toHaveBeenCalled();
    expect(store.getState().flow).toBe(before);
    expect(store.getState().undoStack).toHaveLength(0);
    expect(store.getState().fitSeq).toBe(fitSeq);
    logged.mockRestore();
  });

  it("bumps the fit signal once, not the opened count, when nodes move", async () => {
    const store = loaded(messy());
    const { fitSeq, opened } = store.getState();

    await store.getState().tidy();

    expect(store.getState().fitSeq).toBe(fitSeq + 1);
    expect(store.getState().opened).toBe(opened);
  });

  it("adds no undo entry and leaves the fit signal alone when nothing moves", async () => {
    const store = loaded(await laidOut(messy()));
    const { flow: before, fitSeq } = store.getState();

    await store.getState().tidy();

    expect(store.getState().undoStack).toEqual([]);
    expect(store.getState().fitSeq).toBe(fitSeq);
    expect(store.getState().flow).toBe(before);
  });

  it("drops its result when the flow changed while the layout ran", async () => {
    const store = loaded(messy());
    const { fitSeq } = store.getState();

    const pending = store.getState().tidy();
    store.getState().drop("gate", { x: 900, y: 900 });
    const edited = store.getState().flow;
    await pending;

    expect(store.getState().flow).toBe(edited);
    expect(store.getState().undoStack).toHaveLength(1);
    expect(store.getState().fitSeq).toBe(fitSeq);
  });

  it("lays out for a 1600 by 1000 canvas until the canvas size is set", async () => {
    const source = longChain();
    const store = loaded(source);
    expect(store.getState().canvasSize).toBeNull();

    await store.getState().tidy();

    expect(store.getState().flow).toEqual(await laidOut(source));
  });

  it("lays out for the canvas size it was given", async () => {
    const source = longChain();
    const wide = { width: 100000, height: 1000 };
    const store = loaded(source);

    store.getState().setCanvasSize(wide);
    await store.getState().tidy();

    expect(store.getState().canvasSize).toEqual(wide);
    expect(await laidOut(source, wide)).not.toEqual(await laidOut(source));
    expect(store.getState().flow).toEqual(await laidOut(source, wide));
  });

  describe("foldIntoTop", () => {
    const agentEdited = async () => {
      const store = loaded(messy());
      const original = store.getState().flow;
      const [first] = original.nodes;
      if (first === undefined) throw new Error("expected a node");
      const expected = updateNode({ ...first, label: "Renamed" });
      store.getState().applyAgent(expected);
      const snapshot = store.getState().flow;
      const moves = await tidyMoves(snapshot, defaultCanvas);
      const other = updateNode({ ...first, label: "Other" });
      return { store, original, expected, other, snapshot, moves };
    };

    it("folds the moves into the top undo entry and bumps the fit signal", async () => {
      const { store, original, expected, snapshot, moves } = await agentEdited();
      const { fitSeq } = store.getState();

      expect(store.getState().foldIntoTop(expected, snapshot, moves)).toBe(true);

      expect(store.getState().flow).toEqual(moveNodes(moves).do(snapshot));
      expect(store.getState().undoStack).toHaveLength(1);
      expect(store.getState().fitSeq).toBe(fitSeq + 1);

      store.getState().undo();

      expect(store.getState().flow).toEqual(original);
    });

    it.each([
      ["the top undo entry is another command", "top"],
      ["the flow is not the snapshot", "flow"],
    ])("changes nothing and returns false when %s", async (_, stale) => {
      const { store, original, expected, other, snapshot, moves } = await agentEdited();
      const before = store.getState();

      const folded =
        stale === "top"
          ? store.getState().foldIntoTop(other, snapshot, moves)
          : store.getState().foldIntoTop(expected, original, moves);

      expect(folded).toBe(false);
      expect(store.getState().flow).toBe(before.flow);
      expect(store.getState().undoStack).toBe(before.undoStack);
      expect(store.getState().fitSeq).toBe(before.fitSeq);
    });
  });
});
