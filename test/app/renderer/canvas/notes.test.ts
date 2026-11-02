import { describe, expect, it } from "vitest";
import {
  createCanvasStore,
  nextNoteId,
  selectDirty,
  selectSelectedNode,
} from "../../../../src/app/renderer/canvas/store.js";
import { toViewNodes } from "../../../../src/app/renderer/canvas/view.js";
import { noteLook } from "../../../../src/app/renderer/nodes/note-look.js";
import { validate } from "../../../../src/core/compiler/validate.js";
import { parseFlow, type CanvasNote, type Flow } from "../../../../src/core/flow/schema.js";
import { flow, loop, prompt, thenWire } from "../../../fixtures/flow-builders.js";

const unfinished = new Set(["required-settings", "session-folder"]);

type Store = ReturnType<typeof createCanvasStore>;

const act = (store: Store, action: (state: ReturnType<Store["getState"]>) => unknown) => {
  action(store.getState());
  const current = store.getState().flow;
  expect(parseFlow(current)).toEqual(current);
  expect(validate(current).filter((error) => !unfinished.has(error.rule))).toEqual([]);
};

const note = (id: string, more: Partial<CanvasNote> = {}): CanvasNote => ({
  id,
  text: "",
  position: { x: 0, y: 0 },
  size: { ...noteLook.size },
  ...more,
});

const notesOf = (store: Store) => store.getState().flow.notes;

const loaded = (input: Flow) => {
  const store = createCanvasStore();
  store.getState().load(input);
  return store;
};

const promptAndNote = () =>
  loaded({
    ...flow([{ ...prompt("prompt-1"), position: { x: 300, y: 0 } }], []),
    notes: [note("n1", { text: "Why", position: { x: 0, y: 0 } })],
  });

describe("noteLook", () => {
  it("starts a note larger than its minimum size", () => {
    expect(noteLook.size.width).toBeGreaterThan(noteLook.minSize.width);
    expect(noteLook.size.height).toBeGreaterThan(noteLook.minSize.height);
  });
});

describe("nextNoteId", () => {
  it("numbers from n1 on a flow without notes", () => {
    expect(nextNoteId(flow([], []))).toBe("n1");
  });

  it("takes the lowest number no note or node uses, ignoring case", () => {
    const current = {
      ...flow([prompt("N2")], []),
      notes: [note("n1"), note("n4")],
    };
    expect(nextNoteId(current)).toBe("n3");
  });
});

describe("adding a note", () => {
  it("drops an empty note of the default size at the drop point, selected alone", () => {
    const store = createCanvasStore();
    act(store, (s) => s.drop("prompt", { x: 400, y: 0 }));

    act(store, (s) => s.drop("note", { x: 12, y: 34 }));

    expect(notesOf(store)).toEqual([note("n1", { position: { x: 12, y: 34 } })]);
    expect(store.getState().flow.nodes).toHaveLength(1);
    expect(store.getState().selection).toEqual(["n1"]);
    expect(store.getState().undoStack).toHaveLength(2);
  });

  it("drops a note where it is dropped even over a node", () => {
    const store = createCanvasStore();
    act(store, (s) => s.drop("prompt", { x: 0, y: 0 }));

    act(store, (s) => s.drop("note", { x: 10, y: 10 }));

    expect(notesOf(store)?.[0]?.position).toEqual({ x: 10, y: 10 });
  });

  it("adds a note at (80, 80) on an empty canvas", () => {
    const store = createCanvasStore();

    act(store, (s) => s.addNext("note"));

    expect(notesOf(store)).toEqual([note("n1", { position: { x: 80, y: 80 } })]);
  });

  it("undo removes the note and leaves the canvas clean with no notes key; redo puts it back", () => {
    const store = createCanvasStore();
    const start = store.getState().flow;
    act(store, (s) => s.drop("note", { x: 0, y: 0 }));
    const added = store.getState().flow;
    expect(selectDirty(store.getState())).toBe(true);

    act(store, (s) => s.undo());

    expect(store.getState().flow).toStrictEqual(start);
    expect(store.getState().flow).not.toHaveProperty("notes");
    expect(store.getState().selection).toEqual([]);
    expect(selectDirty(store.getState())).toBe(false);

    act(store, (s) => s.redo());

    expect(store.getState().flow).toEqual(added);
  });

  it("records nothing before the store is ready", () => {
    const store = createCanvasStore({ ready: false });

    store.getState().drop("note", { x: 0, y: 0 });

    expect(notesOf(store)).toBeUndefined();
    expect(store.getState().undoStack).toEqual([]);
  });
});

describe("editing a note's text", () => {
  it("sets the text as one command; undo and redo flip it", () => {
    const store = promptAndNote();

    act(store, (s) => s.editNoteText("n1", "Plan first,\nthen build"));

    expect(notesOf(store)?.[0]?.text).toBe("Plan first,\nthen build");
    expect(store.getState().undoStack).toHaveLength(1);

    act(store, (s) => s.undo());
    expect(notesOf(store)?.[0]?.text).toBe("Why");

    act(store, (s) => s.redo());
    expect(notesOf(store)?.[0]?.text).toBe("Plan first,\nthen build");
  });

  it("records nothing when the text is unchanged or the note is gone", () => {
    const store = promptAndNote();

    act(store, (s) => s.editNoteText("n1", "Why"));
    act(store, (s) => s.editNoteText("n9", "x"));

    expect(store.getState().undoStack).toEqual([]);
  });
});

describe("moving a note", () => {
  it("keeps the drag live, then records one move; undo and redo flip it", () => {
    const store = promptAndNote();
    const before = store.getState().flow;

    act(store, (s) => s.dragTo("n1", { x: 50, y: 60 }));
    expect(store.getState().flow).toBe(before);

    act(store, (s) => s.endDrag(["n1"]));

    expect(notesOf(store)?.[0]?.position).toEqual({ x: 50, y: 60 });
    expect(store.getState().undoStack).toHaveLength(1);
    expect(store.getState().dragPositions).toEqual({});

    act(store, (s) => s.undo());
    expect(store.getState().flow).toEqual(before);

    act(store, (s) => s.redo());
    expect(notesOf(store)?.[0]?.position).toEqual({ x: 50, y: 60 });
  });

  it("moves a note and a node dragged together as one command", () => {
    const store = promptAndNote();
    const before = store.getState().flow;

    act(store, (s) => s.dragTo("n1", { x: 5, y: 5 }));
    act(store, (s) => s.dragTo("prompt-1", { x: 305, y: 5 }));
    act(store, (s) => s.endDrag(["n1", "prompt-1"]));

    expect(notesOf(store)?.[0]?.position).toEqual({ x: 5, y: 5 });
    expect(store.getState().flow.nodes[0]?.position).toEqual({ x: 305, y: 5 });
    expect(store.getState().undoStack).toHaveLength(1);

    act(store, (s) => s.undo());
    expect(store.getState().flow).toEqual(before);
  });
});

describe("resizing a note", () => {
  const box = { x: -10, y: -20, width: 300, height: 180 };

  it("keeps the live box out of the flow and the undo stack", () => {
    const store = promptAndNote();
    const before = store.getState().flow;

    act(store, (s) => s.resizeNoteLive("n1", box));

    expect(store.getState().flow).toBe(before);
    expect(store.getState().noteBoxes).toEqual({ n1: box });
    expect(store.getState().undoStack).toEqual([]);
  });

  it("records the new position and size as one command and clears the live box", () => {
    const store = promptAndNote();
    act(store, (s) => s.resizeNoteLive("n1", box));

    act(store, (s) => s.resizeNote("n1", box));

    expect(notesOf(store)?.[0]).toMatchObject({
      position: { x: -10, y: -20 },
      size: { width: 300, height: 180 },
    });
    expect(store.getState().noteBoxes).toEqual({});
    expect(store.getState().undoStack).toHaveLength(1);
  });

  it("undo restores the old box and redo the new one", () => {
    const store = promptAndNote();
    const before = store.getState().flow;
    act(store, (s) => s.resizeNote("n1", box));
    const after = store.getState().flow;

    act(store, (s) => s.undo());
    expect(store.getState().flow).toEqual(before);

    act(store, (s) => s.redo());
    expect(store.getState().flow).toEqual(after);
  });

  it("never records a size below the minimum", () => {
    const store = promptAndNote();

    act(store, (s) => s.resizeNote("n1", { x: 0, y: 0, width: 1, height: 1 }));

    expect(notesOf(store)?.[0]?.size).toEqual(noteLook.minSize);
  });

  it("records nothing when the box is unchanged", () => {
    const store = promptAndNote();
    const { position, size } = note("n1");

    act(store, (s) => s.resizeNote("n1", { ...position, ...size }));

    expect(store.getState().undoStack).toEqual([]);
    expect(store.getState().noteBoxes).toEqual({});
  });
});

describe("deleting a note", () => {
  it("deletes a selected note; undo puts it back in its place and redo deletes it again", () => {
    const store = loaded({
      ...flow([prompt("prompt-1")], []),
      notes: [note("n1"), note("n2", { text: "middle" }), note("n3")],
    });
    const before = store.getState().flow;
    act(store, (s) => s.select(["n2"]));

    act(store, (s) => s.deleteSelection());

    expect(notesOf(store)?.map(({ id }) => id)).toEqual(["n1", "n3"]);
    expect(store.getState().selection).toEqual([]);

    act(store, (s) => s.undo());
    expect(store.getState().flow).toEqual(before);

    act(store, (s) => s.redo());
    expect(notesOf(store)?.map(({ id }) => id)).toEqual(["n1", "n3"]);
  });

  it("deletes a note and a node selected together as one command", () => {
    const store = promptAndNote();
    const before = store.getState().flow;
    act(store, (s) => s.select(["n1", "prompt-1"]));

    act(store, (s) => s.deleteSelection());

    expect(store.getState().flow.nodes).toEqual([]);
    expect(store.getState().flow).not.toHaveProperty("notes");
    expect(store.getState().undoStack).toHaveLength(1);

    act(store, (s) => s.undo());
    expect(store.getState().flow).toEqual(before);
  });

  it("deletes a note by id", () => {
    const store = promptAndNote();

    act(store, (s) => s.deleteNodes(["n1"]));

    expect(store.getState().flow).not.toHaveProperty("notes");
  });
});

describe("a selected note", () => {
  it("stays selected across other edits", () => {
    const store = promptAndNote();
    act(store, (s) => s.select(["n1"]));

    act(store, (s) => s.editNoteText("n1", "changed"));

    expect(store.getState().selection).toEqual(["n1"]);
  });

  it("is not a node, so the node settings panel has nothing to show", () => {
    const store = promptAndNote();

    act(store, (s) => s.select(["n1"]));

    expect(selectSelectedNode(store.getState())).toBeNull();
  });
});

describe("selecting all", () => {
  it("selects every node and every note", () => {
    const store = promptAndNote();

    store.getState().selectAll();

    expect(store.getState().selection).toEqual(["prompt-1", "n1"]);
  });
});

describe("toViewNodes with notes", () => {
  const noted = (): Flow => ({
    ...flow(
      [
        { ...prompt("a"), position: { x: 0, y: 0 } },
        { ...prompt("b"), position: { x: 300, y: 0 } },
      ],
      [thenWire("a", "b")],
    ),
    notes: [note("n1", { text: "Why", position: { x: 40, y: 200 } })],
  });

  it("draws each note as a note view node with its box and text", () => {
    const view = toViewNodes(noted(), ["n1"], {}, null).find(({ id }) => id === "n1");

    expect(view).toEqual({
      id: "n1",
      type: "note",
      position: { x: 40, y: 200 },
      width: noteLook.size.width,
      height: noteLook.size.height,
      selected: true,
      data: { text: "Why" },
    });
  });

  it("takes a held drag position and a live resize box over the saved ones", () => {
    const dragged = toViewNodes(noted(), [], { n1: { x: 1, y: 2 } }, null).find(
      ({ id }) => id === "n1",
    );
    const resized = toViewNodes(noted(), [], {}, null, {
      n1: { x: 3, y: 4, width: 333, height: 222 },
    }).find(({ id }) => id === "n1");

    expect(dragged).toMatchObject({ position: { x: 1, y: 2 } });
    expect(resized).toMatchObject({ position: { x: 3, y: 4 }, width: 333, height: 222 });
  });

  it("puts notes after the frames and before the nodes, so nodes draw over them", () => {
    const looped: Flow = {
      ...flow([loop("L"), prompt("a", { parent: "L" })], []),
      notes: noted().notes ?? [],
    };

    expect(toViewNodes(looped, [], {}, null).map(({ id }) => id)).toEqual([
      "loop-frame-L",
      "n1",
      "L",
      "a",
    ]);
  });
});
