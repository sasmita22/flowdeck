import { describe, expect, it, vi } from "vitest";
import {
  createCanvasStore,
  nextNodeId,
  type CanvasNodeType,
} from "../../../../src/app/renderer/canvas/store.js";
import { validate } from "../../../../src/core/compiler/validate.js";
import { parseFlow, type Flow } from "../../../../src/core/flow/schema.js";
import { flow, prompt } from "../../../fixtures/flow-builders.js";

type Store = ReturnType<typeof createCanvasStore>;

const nodeIdRule = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

const expectValid = (current: Flow) => {
  expect(parseFlow(current)).toEqual(current);
  expect(validate(current)).toEqual([]);
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
  act(store, (s) => s.drop("prompt", { x: 0, y: 0 }));
  act(store, (s) => s.drop("prompt", { x: 200, y: 0 }));
  act(store, (s) => s.drop("script", { x: 0, y: 200 }));
  act(store, (s) => s.drop("script", { x: 200, y: 200 }));
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
  it("starts with an empty valid flow, no selection and empty stacks", () => {
    const state = createCanvasStore().getState();

    expect(state.flow).toEqual(flow([], []));
    expect(state.selection).toEqual([]);
    expect(state.undoStack).toEqual([]);
    expect(state.redoStack).toEqual([]);
    expect(state.dragPositions).toEqual({});
    expectValid(state.flow);
  });
});

describe("drop", () => {
  it("adds one Prompt at the drop position with core defaults, selected alone", () => {
    const store = createCanvasStore();

    act(store, (s) => s.drop("prompt", { x: 120, y: 80 }));

    const state = store.getState();
    expect(state.flow.nodes).toEqual([
      {
        id: "prompt-1",
        type: "prompt",
        label: "Prompt",
        position: { x: 120, y: 80 },
        settings: { instructions: "" },
      },
    ]);
    expect(state.flow.wires).toEqual([]);
    expect(state.selection).toEqual(["prompt-1"]);
    expect(state.undoStack).toHaveLength(1);
  });

  it("adds one Script at the drop position with core defaults, selected alone", () => {
    const store = createCanvasStore();

    act(store, (s) => s.drop("script", { x: 40, y: 300 }));

    const state = store.getState();
    expect(state.flow.nodes).toEqual([
      {
        id: "script-1",
        type: "script",
        label: "Script",
        position: { x: 40, y: 300 },
        settings: { command: "" },
      },
    ]);
    expect(state.selection).toEqual(["script-1"]);
  });

  it("replaces the selection with the node dropped second", () => {
    const store = createCanvasStore();

    act(store, (s) => s.drop("prompt", { x: 0, y: 0 }));
    act(store, (s) => s.drop("prompt", { x: 50, y: 50 }));

    expect(store.getState().flow.nodes.map((node) => node.id)).toEqual(["prompt-1", "prompt-2"]);
    expect(store.getState().selection).toEqual(["prompt-2"]);
  });
});

describe("connect", () => {
  const twoNodes = () => {
    const store = createCanvasStore();
    act(store, (s) => s.drop("prompt", { x: 0, y: 0 }));
    act(store, (s) => s.drop("script", { x: 200, y: 0 }));
    return store;
  };

  it("adds exactly one then wire from an output port to an input port", () => {
    const store = twoNodes();

    const accepted = act(store, (s) => s.connect(end("prompt-1", "out"), end("script-1", "in")));

    expect(accepted).toBe(true);
    expect(store.getState().flow.wires).toEqual([then("prompt-1", "script-1")]);
    expect(store.getState().undoStack).toHaveLength(3);
  });

  const refused: [
    string,
    boolean,
    { node: string; port: string },
    { node: string; port: string },
  ][] = [
    ["a self-loop", false, end("prompt-1", "out"), end("prompt-1", "in")],
    ["a cycle", true, end("script-1", "out"), end("prompt-1", "in")],
    ["output to output", false, end("prompt-1", "out"), end("script-1", "out")],
    ["input to input", false, end("prompt-1", "in"), end("script-1", "in")],
    ["a duplicate wire", true, end("prompt-1", "out"), end("script-1", "in")],
    ["an unknown node", false, end("prompt-1", "out"), end("ghost-1", "in")],
    ["an unknown input port", false, end("prompt-1", "out"), end("script-1", "nope")],
    ["an unknown output port", false, end("prompt-1", "nope"), end("script-1", "in")],
  ];

  it.each(refused)("refuses %s and records nothing", (_name, wired, from, to) => {
    const store = twoNodes();
    if (wired) act(store, (s) => s.connect(end("prompt-1", "out"), end("script-1", "in")));
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

describe("move", () => {
  it("keeps live drag positions out of the flow and records one move on drag end", () => {
    const store = createCanvasStore();
    act(store, (s) => s.drop("prompt", { x: 0, y: 0 }));
    const before = store.getState().flow;

    act(store, (s) => s.dragTo("prompt-1", { x: 50, y: 60 }));

    expect(store.getState().flow).toBe(before);
    expect(store.getState().dragPositions).toEqual({ "prompt-1": { x: 50, y: 60 } });

    act(store, (s) => s.endDrag(["prompt-1"]));

    expect(store.getState().undoStack).toHaveLength(2);
    expect(store.getState().flow.nodes[0]?.position).toEqual({ x: 50, y: 60 });
    expect(store.getState().dragPositions).toEqual({});

    act(store, (s) => s.undo());

    expect(store.getState().flow.nodes[0]?.position).toEqual({ x: 0, y: 0 });
  });

  it("records one move for nodes dragged together and leaves undragged ids alone", () => {
    const store = createCanvasStore();
    act(store, (s) => s.drop("prompt", { x: 0, y: 0 }));
    act(store, (s) => s.drop("script", { x: 100, y: 0 }));
    act(store, (s) => s.drop("script", { x: 200, y: 0 }));
    const before = store.getState().flow;

    act(store, (s) => s.dragTo("prompt-1", { x: 10, y: 50 }));
    act(store, (s) => s.dragTo("script-1", { x: 110, y: 50 }));
    act(store, (s) => s.endDrag(["prompt-1", "script-1", "script-2"]));

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
    act(store, (s) => s.drop("prompt", { x: 10, y: 10 }));

    act(store, (s) => s.endDrag(["prompt-1"]));
    act(store, (s) => s.dragTo("prompt-1", { x: 10, y: 10 }));
    act(store, (s) => s.endDrag(["prompt-1"]));

    expect(store.getState().undoStack).toHaveLength(1);
    expect(store.getState().dragPositions).toEqual({});
  });
});

describe("undo and redo", () => {
  it("redo puts the same command back and replays it with the same ids", () => {
    const store = createCanvasStore();
    act(store, (s) => s.drop("prompt", { x: 0, y: 0 }));
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
    act(store, (s) => s.drop("prompt", { x: 0, y: 0 }));
    flows.push(store.getState().flow);
    act(store, (s) => s.drop("script", { x: 200, y: 0 }));
    flows.push(store.getState().flow);
    act(store, (s) => s.connect(end("prompt-1", "out"), end("script-1", "in")));
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
    act(store, (s) => s.drop("prompt", { x: 0, y: 0 }));
    act(store, (s) => s.undo());

    act(store, (s) => s.drop("script", { x: 0, y: 0 }));

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
    act(store, (s) => s.drop("prompt", { x: 0, y: 0 }));
    act(store, (s) => s.drop("prompt", { x: 100, y: 0 }));
    act(store, (s) => s.select(["prompt-1", "prompt-2"]));

    act(store, (s) => s.undo());

    expect(store.getState().selection).toEqual(["prompt-1"]);
  });

  it("drops ids from the selection that a redo removes", () => {
    const store = createCanvasStore();
    act(store, (s) => s.drop("prompt", { x: 0, y: 0 }));
    act(store, (s) => s.drop("prompt", { x: 100, y: 0 }));
    act(store, (s) => s.deleteNodes(["prompt-2"]));
    act(store, (s) => s.undo());
    act(store, (s) => s.select(["prompt-1", "prompt-2"]));

    act(store, (s) => s.redo());

    expect(store.getState().selection).toEqual(["prompt-1"]);
  });
});

describe("node ids", () => {
  it("drops with the injected id source", () => {
    const nextId = vi.fn((type: CanvasNodeType) => `${type}-custom`);
    const store = createCanvasStore({ nextId });
    const empty = store.getState().flow;

    act(store, (s) => s.drop("script", { x: 0, y: 0 }));

    expect(nextId).toHaveBeenCalledWith("script", empty);
    expect(store.getState().flow.nodes.map((node) => node.id)).toEqual(["script-custom"]);
    expect(store.getState().selection).toEqual(["script-custom"]);
  });

  it("numbers from 1 on an empty flow", () => {
    expect(nextNodeId("prompt", flow([], []))).toBe("prompt-1");
    expect(nextNodeId("script", flow([], []))).toBe("script-1");
  });

  it("skips ids already used, ignoring case", () => {
    expect(nextNodeId("prompt", flow([prompt("Prompt-1")], []))).toBe("prompt-2");
    expect(nextNodeId("prompt", flow([prompt("prompt-1"), prompt("prompt-2")], []))).toBe(
      "prompt-3",
    );
  });

  it("takes the lowest free number", () => {
    expect(nextNodeId("prompt", flow([prompt("prompt-2")], []))).toBe("prompt-1");
  });

  it("generates ids the node-ids rule accepts", () => {
    const store = createCanvasStore();
    dropFour(store);

    for (const node of store.getState().flow.nodes) expect(node.id).toMatch(nodeIdRule);
  });
});
