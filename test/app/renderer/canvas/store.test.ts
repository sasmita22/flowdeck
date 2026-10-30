import { describe, expect, it, vi } from "vitest";
import {
  createCanvasStore,
  newCanvasFlow,
  nextNodeId,
  selectDirty,
  wrappableIds,
  type CanvasNodeType,
} from "../../../../src/app/renderer/canvas/store.js";
import { SESSION_FRAME_ID, toViewNodes } from "../../../../src/app/renderer/canvas/view.js";
import { validate } from "../../../../src/core/compiler/validate.js";
import { parseFlow, type Flow, type Session } from "../../../../src/core/flow/schema.js";
import {
  flow,
  hardstop,
  loop,
  output,
  prompt,
  script,
  thenWire,
  trigger,
} from "../../../fixtures/flow-builders.js";

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

  it("is ready by default, with the starting flow as the saved flow and clean", () => {
    const state = createCanvasStore().getState();

    expect(state.ready).toBe(true);
    expect(state.saved).toEqual(newCanvasFlow());
    expect(selectDirty(state)).toBe(false);
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

const locked = "Hard stop is locked";

const guarded = () => {
  const store = createCanvasStore({ ready: false });
  store
    .getState()
    .load(
      flow(
        [trigger("T"), prompt("P"), hardstop("H"), output("O")],
        [thenWire("T", "P"), thenWire("P", "H"), thenWire("H", "O")],
      ),
    );
  return store;
};

describe("hard stop lock", () => {
  it("starts with no message", () => {
    expect(createCanvasStore().getState().message).toBeNull();
  });

  it("keeps a hard stop deleted by id, shows the locked message and records nothing", () => {
    const store = guarded();
    const before = store.getState();

    act(store, (s) => s.deleteNodes(["H"]));

    const after = store.getState();
    expect(after.flow).toEqual(before.flow);
    expect(after.message).toBe(locked);
    expect(after.undoStack).toBe(before.undoStack);
    expect(after.redoStack).toBe(before.redoStack);
  });

  it("deletes the rest of a mixed selection as one undoable command and keeps the hard stop", () => {
    const store = guarded();
    const before = store.getState().flow;
    act(store, (s) => s.select(["P", "H"]));

    act(store, (s) => s.deleteSelection());

    const after = store.getState();
    expect(after.flow.nodes.map((node) => node.id)).toEqual(["T", "H", "O"]);
    expect(after.flow.wires).toEqual([then("H", "O")]);
    expect(after.message).toBe(locked);
    expect(after.undoStack).toHaveLength(1);

    act(store, (s) => s.undo());

    expect(store.getState().flow).toEqual(before);
  });

  it("leaves only the hard stop when every node is selected and deleted", () => {
    const store = guarded();
    act(store, (s) => s.select(s.flow.nodes.map((node) => node.id)));

    act(store, (s) => s.deleteSelection());

    const after = store.getState();
    expect(after.flow.nodes.map((node) => node.id)).toEqual(["H"]);
    expect(after.flow.wires).toEqual([]);
    expect(after.message).toBe(locked);
    expect(after.undoStack).toHaveLength(1);
  });

  it("shows no message for a delete without a hard stop", () => {
    const store = guarded();

    act(store, (s) => s.deleteNodes(["P"]));

    expect(store.getState().message).toBeNull();
  });

  it("clears the message on the next successful edit", () => {
    const store = guarded();
    act(store, (s) => s.deleteNodes(["H"]));

    act(store, (s) => s.drop("prompt", { x: 0, y: 300 }));

    expect(store.getState().message).toBeNull();
  });

  it("clears the message when the selection changes", () => {
    const store = guarded();
    act(store, (s) => s.deleteNodes(["H"]));

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
    act(store, (s) => s.drop("prompt", { x: 0, y: 0 }));
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

const savedFlow = () =>
  flow(
    [
      { ...prompt("prompt-1"), position: { x: 10, y: 20 } },
      { ...script("script-1"), position: { x: 300, y: 20 } },
    ],
    [thenWire("prompt-1", "script-1")],
  );

describe("edit gate", () => {
  it("is not ready when created with ready false", () => {
    expect(createCanvasStore({ ready: false }).getState().ready).toBe(false);
  });

  const gated: [string, (state: ReturnType<Store["getState"]>) => unknown][] = [
    ["drop", (s) => s.drop("prompt", { x: 0, y: 0 })],
    ["connect", (s) => s.connect(end("prompt-1", "out"), end("script-1", "in"))],
    ["deleteNodes", (s) => s.deleteNodes(["prompt-1"])],
    ["dragTo", (s) => s.dragTo("prompt-1", { x: 50, y: 50 })],
    ["endDrag", (s) => s.endDrag(["prompt-1"])],
    ["wrapSelection", (s) => s.wrapSelection()],
    ["updateSession", (s) => s.updateSession({ ...s.flow.session, model: "haiku" })],
    ["undo", (s) => s.undo()],
    ["redo", (s) => s.redo()],
  ];

  const seededNotReady = () => {
    const source = createCanvasStore();
    act(source, (s) => s.drop("prompt", { x: 0, y: 0 }));
    act(source, (s) => s.drop("script", { x: 200, y: 0 }));
    act(source, (s) => s.drop("prompt", { x: 400, y: 0 }));
    act(source, (s) => s.undo());
    const { flow: seeded, undoStack, redoStack } = source.getState();
    const store = createCanvasStore({ ready: false });
    store.setState({
      flow: seeded,
      undoStack,
      redoStack,
      selection: ["prompt-1", "script-1"],
      dragPositions: { "prompt-1": { x: 50, y: 50 } },
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

    store.getState().drop("prompt", { x: 0, y: 0 });

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
    act(store, (s) => s.drop("prompt", { x: 0, y: 0 }));
    act(store, (s) => s.drop("prompt", { x: 100, y: 0 }));
    act(store, (s) => s.undo());
    act(store, (s) => s.select(["prompt-1"]));
    act(store, (s) => s.dragTo("prompt-1", { x: 40, y: 40 }));

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

    act(store, (s) => s.drop("prompt", { x: 0, y: 300 }));

    expect(store.getState().flow.nodes.map((node) => node.id)).toEqual([
      "prompt-1",
      "script-1",
      "prompt-2",
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

    act(store, (s) => s.drop("prompt", { x: 0, y: 300 }));
    expect(selectDirty(store.getState())).toBe(true);

    act(store, (s) => s.undo());
    expect(selectDirty(store.getState())).toBe(false);
  });

  it("stays clean when only the selection changes", () => {
    const store = loadedStore();

    act(store, (s) => s.select(["prompt-1", "script-1"]));
    act(store, (s) => s.select([]));

    expect(selectDirty(store.getState())).toBe(false);
  });
});

describe("markSaved", () => {
  it("sets the saved flow, so the current flow reads clean", () => {
    const store = createCanvasStore();
    act(store, (s) => s.drop("prompt", { x: 0, y: 0 }));
    const snapshot = store.getState().flow;
    expect(selectDirty(store.getState())).toBe(true);

    store.getState().markSaved(snapshot);

    expect(store.getState().saved).toEqual(snapshot);
    expect(selectDirty(store.getState())).toBe(false);
  });

  it("stays dirty when an edit happened after the snapshot was taken", () => {
    const store = createCanvasStore();
    act(store, (s) => s.drop("prompt", { x: 0, y: 0 }));
    const snapshot = store.getState().flow;
    act(store, (s) => s.drop("script", { x: 200, y: 0 }));

    store.getState().markSaved(snapshot);

    expect(store.getState().saved).toEqual(snapshot);
    expect(selectDirty(store.getState())).toBe(true);
  });
});

const framed = (source: Flow, nodes: string[]): Flow => ({
  ...source,
  session: { ...source.session, frame: { nodes } },
});

const loopWithBody = () => flow([loop("L"), prompt("X", { parent: "L" }), prompt("A")], []);

describe("wrappableIds", () => {
  it("returns the selected top-level ids that are not members yet, in selection order", () => {
    const source = framed(
      flow([loop("L"), prompt("X", { parent: "L" }), prompt("A"), prompt("B")], []),
      ["B"],
    );

    expect(wrappableIds(source, ["A", "X", "B", "ghost", "L"])).toEqual(["A", "L"]);
  });

  it("is empty for an empty selection", () => {
    expect(wrappableIds(loopWithBody(), [])).toEqual([]);
  });

  it("is empty when only loop-body nodes are selected", () => {
    expect(wrappableIds(loopWithBody(), ["X"])).toEqual([]);
  });
});

describe("wrapSelection", () => {
  it("frames the four selected nodes as one undo step and undo leaves the canvas clean", () => {
    const store = createCanvasStore();
    const { a, b, c, d } = dropFour(store);
    store.getState().markSaved(store.getState().flow);
    act(store, (s) => s.select([a, b, c, d]));
    const depth = store.getState().undoStack.length;

    act(store, (s) => s.wrapSelection());

    expect(store.getState().flow.session.frame).toEqual({ nodes: [a, b, c, d] });
    expect(store.getState().undoStack).toHaveLength(depth + 1);
    expect(selectDirty(store.getState())).toBe(true);

    act(store, (s) => s.undo());

    expect(Object.hasOwn(store.getState().flow.session, "frame")).toBe(false);
    expect(selectDirty(store.getState())).toBe(false);
  });

  it("records nothing when the selection is empty", () => {
    const store = createCanvasStore();
    dropFour(store);
    act(store, (s) => s.select([]));
    const before = store.getState();

    act(store, (s) => s.wrapSelection());

    expect(store.getState().undoStack).toBe(before.undoStack);
    expect(store.getState().flow).toBe(before.flow);
  });

  it("never reuses the id of a deleted frame member for a new node", () => {
    const store = createCanvasStore();
    const { a, b, c, d } = dropFour(store);
    act(store, (s) => s.select([a]));
    act(store, (s) => s.wrapSelection());
    act(store, (s) => s.deleteNodes([a]));

    act(store, (s) => s.drop("prompt", { x: 600, y: 600 }));

    const { flow } = store.getState();
    const added = flow.nodes.map((node) => node.id).filter((id) => ![b, c, d].includes(id));
    expect(added).toHaveLength(1);
    expect(added).not.toContain(a);
    expect(flow.session.frame).toEqual({ nodes: [a] });
    expect(toViewNodes(flow, [], {}, null).map((node) => node.id)).not.toContain(SESSION_FRAME_ID);
  });

  it("records nothing when only loop-body nodes are selected", () => {
    const store = createCanvasStore({ ready: false });
    store.getState().load(loopWithBody());
    store.getState().select(["X"]);
    const before = store.getState();

    store.getState().wrapSelection();

    expect(store.getState().undoStack).toBe(before.undoStack);
    expect(store.getState().flow).toBe(before.flow);
  });
});

describe("updateSession", () => {
  const edited: Session = {
    name: "main",
    workingFolder: { kind: "path", path: "/tmp/x" },
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
  it("defaults to a worktree folder on main and no frame", () => {
    const { session } = newCanvasFlow();

    expect(session.workingFolder).toEqual({ kind: "worktree", branch: "main" });
    expect(Object.hasOwn(session, "frame")).toBe(false);
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

    store.getState().highlight("prompt-1");

    const state = store.getState();
    expect(state.highlighted).toBe("prompt-1");
    expect(state.selection).toEqual([]);
    expect(state.undoStack).toBe(before.undoStack);
    expect(state.redoStack).toBe(before.redoStack);
    expect(state.flow).toBe(before.flow);
    expect(selectDirty(state)).toBe(false);
  });

  it("clears the highlight with null", () => {
    const store = loadedStore();
    store.getState().highlight("prompt-1");

    store.getState().highlight(null);

    expect(store.getState().highlighted).toBeNull();
  });
});
