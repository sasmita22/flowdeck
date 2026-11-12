import { describe, expect, it } from "vitest";
import {
  createCanvasStore,
  newCanvasFlow,
  selectCanDelete,
  selectNodeIssues,
  selectSessionIssues,
} from "../../../../src/app/renderer/canvas/store.js";
import { edgeId } from "../../../../src/app/renderer/canvas/view.js";
import type { Flow, Wire } from "../../../../src/core/flow/schema.js";
import {
  agent,
  flow,
  forEach,
  fork,
  gate,
  hardstop,
  loop,
  thenWire,
  trigger,
} from "../../../fixtures/flow-builders.js";

const at = <N extends object>(node: N, x: number, y: number) => ({ ...node, position: { x, y } });

const loaded = (current: Flow) => {
  const store = createCanvasStore();
  store.getState().load(current);
  return store;
};

const ids = (current: Flow) => current.nodes.map((node) => node.id);
const nodeOf = (current: Flow, id: string) => current.nodes.find((node) => node.id === id);
const ends = (current: Flow) => current.wires.map((wire) => `${wire.from.node}>${wire.to.node}`);

const chain = () =>
  flow(
    [
      { ...at(agent("A"), 0, 0), label: "Plan" },
      { ...at(agent("B"), 200, 0), label: "Test" },
      { ...at(agent("C"), 400, 0), label: "Fix" },
    ],
    [thenWire("A", "B"), thenWire("B", "C")],
  );

const wireAt = (current: Flow, index: number): Wire => {
  const wire = current.wires[index];
  if (wire === undefined) throw new Error(`no wire ${index}`);
  return wire;
};

describe("selecting and deleting wires", () => {
  it("deletes a selected Then wire with Delete, and one undo puts it back in place", () => {
    const store = loaded(chain());
    const before = store.getState().flow;

    store.getState().selectWires([edgeId(wireAt(before, 1))]);
    expect(selectCanDelete(store.getState())).toBe(true);
    store.getState().deleteSelection();

    expect(ends(store.getState().flow)).toEqual(["A>B"]);
    expect(ids(store.getState().flow)).toEqual(["A", "B", "C"]);
    expect(store.getState().selectedWires).toEqual([]);
    store.getState().undo();
    expect(store.getState().flow).toEqual(before);
    store.getState().redo();
    expect(ends(store.getState().flow)).toEqual(["A>B"]);
  });

  it("deletes selected nodes and a selected wire elsewhere as one undo step", () => {
    const store = loaded(chain());
    const before = store.getState().flow;

    store.getState().select(["C"]);
    store.getState().selectWires([edgeId(wireAt(before, 0))]);
    store.getState().deleteSelection();

    expect(ids(store.getState().flow)).toEqual(["A", "B"]);
    expect(store.getState().flow.wires).toEqual([]);
    expect(store.getState().undoStack).toHaveLength(1);
    store.getState().undo();
    expect(store.getState().flow).toEqual(before);
  });

  it("forgets a selected wire that an undo takes away", () => {
    const store = loaded(flow([agent("A"), agent("B")], []));
    store.getState().connect({ node: "A", port: "out" }, { node: "B", port: "in" });
    store.getState().selectWires([edgeId(wireAt(store.getState().flow, 0))]);

    store.getState().undo();

    expect(store.getState().selectedWires).toEqual([]);
    expect(selectCanDelete(store.getState())).toBe(false);
  });
});

describe("refused connections", () => {
  it("names both nodes by their labels and says why, without ids or rule names", () => {
    const store = loaded(
      flow(
        [
          { ...fork("fork-1"), label: "Fork" },
          { ...gate("gate-1"), label: "Check" },
        ],
        [],
      ),
    );

    expect(
      store.getState().connect({ node: "fork-1", port: "out" }, { node: "gate-1", port: "in" }),
    ).toBe(false);

    expect(store.getState().message).toBe(
      "Can't connect Fork to Check: Check is a parallel branch that is not an Agent.",
    );
    expect(store.getState().flow.wires).toEqual([]);
  });

  it("says a pair is already joined", () => {
    const store = loaded(chain());

    store.getState().connect({ node: "A", port: "out" }, { node: "B", port: "in" });

    expect(store.getState().message).toBe("Can't connect Plan to Test: they are already joined.");
  });

  it("explains a drag the canvas itself turned down, such as output to output", () => {
    const store = loaded(chain());

    store.getState().refuseConnection();

    expect(store.getState().message).toBe(
      "Can't connect those ports: drag from a node's output on its right to another node's input on its left.",
    );
  });
});

describe("deleting a hard stop", () => {
  it("deletes a hard stop added by mistake, and undo brings it back", () => {
    const store = loaded(flow([agent("P"), hardstop("H")], [thenWire("P", "H")]));
    const before = store.getState().flow;

    store.getState().deleteNodes(["H"]);

    expect(ids(store.getState().flow)).toEqual(["P"]);
    expect(store.getState().flow.wires).toEqual([]);
    expect(store.getState().message).toBeNull();
    store.getState().undo();
    expect(store.getState().flow).toEqual(before);
  });

  it("deletes a Loop together with the hard stop in its body, as one undo step", () => {
    const store = loaded(
      flow([loop("L"), agent("P", { parent: "L" }), hardstop("H", { parent: "L" })], []),
    );
    const before = store.getState().flow;

    store.getState().deleteNodes(["L"]);

    expect(store.getState().flow.nodes).toEqual([]);
    store.getState().undo();
    expect(store.getState().flow).toEqual(before);
  });
});

describe("copy, paste and duplicate", () => {
  it("pastes a copy with new ids, its inner wires, an offset, and the copy selected", () => {
    const store = loaded(chain());
    store.getState().select(["A", "B"]);

    store.getState().copy();
    store.getState().paste();

    const { flow: after, selection } = store.getState();
    expect(ids(after)).toEqual(["A", "B", "C", "agent-1", "agent-2"]);
    expect(nodeOf(after, "agent-1")).toMatchObject({ label: "Plan", position: { x: 32, y: 32 } });
    expect(nodeOf(after, "agent-2")).toMatchObject({ label: "Test", position: { x: 232, y: 32 } });
    expect(ends(after)).toEqual(["A>B", "B>C", "agent-1>agent-2"]);
    expect(selection).toEqual(["agent-1", "agent-2"]);
    expect(store.getState().undoStack).toHaveLength(1);
    store.getState().undo();
    expect(ids(store.getState().flow)).toEqual(["A", "B", "C"]);
  });

  it("pastes again further along, so copies do not stack on each other", () => {
    const store = loaded(chain());
    store.getState().select(["A"]);
    store.getState().copy();

    store.getState().paste();
    store.getState().paste();

    expect(nodeOf(store.getState().flow, "agent-2")?.position).toEqual({ x: 64, y: 64 });
  });

  it("copies a Loop with its body, giving the body the new Loop as parent", () => {
    const store = loaded(flow([at(loop("L"), 0, 0), at(agent("P", { parent: "L" }), 0, 80)], []));
    store.getState().select(["L"]);

    store.getState().copy();
    store.getState().paste();

    expect(nodeOf(store.getState().flow, "loop-1")?.parent).toBeUndefined();
    expect(nodeOf(store.getState().flow, "agent-1")).toMatchObject({
      parent: "loop-1",
      position: { x: 32, y: 112 },
    });
  });

  it("pastes into a selected Loop", () => {
    const store = loaded(flow([at(loop("L"), 0, 0), at(agent("P"), 400, 0)], []));
    store.getState().select(["P"]);
    store.getState().copy();

    store.getState().select(["L"]);
    store.getState().paste();

    expect(nodeOf(store.getState().flow, "agent-1")?.parent).toBe("L");
  });

  it("refuses to paste a Trigger into a Loop and says why", () => {
    const store = loaded(flow([at(loop("L"), 0, 0), at(trigger("T"), 400, 0)], []));
    store.getState().select(["T"]);
    store.getState().copy();
    store.getState().select(["L"]);

    store.getState().paste();

    expect(ids(store.getState().flow)).toEqual(["L", "T"]);
    expect(store.getState().message).toMatch(/^Can't paste into L: /);
  });

  it("duplicates an empty Loop, which then shows its missing body as an ordinary issue", () => {
    const store = loaded(flow([at(loop("L"), 0, 0)], []));
    store.getState().select(["L"]);

    store.getState().duplicate();

    const { flow: after, selection, message } = store.getState();
    expect(ids(after)).toEqual(["L", "loop-1"]);
    expect(selection).toEqual(["loop-1"]);
    expect(message).toBeNull();
    expect(selectNodeIssues(after)["loop-1"]).toEqual(
      expect.arrayContaining([expect.stringMatching(/no agent in its body/i)]),
    );
  });

  it("refuses a Loop pasted inside another, naming no target when nothing is selected", () => {
    const store = loaded(
      flow(
        [
          at(loop("outer"), 0, 0),
          at(loop("inner", { parent: "outer" }), 0, 80),
          at(agent("P", { parent: "inner" }), 0, 160),
        ],
        [],
      ),
    );
    store.getState().select(["outer"]);
    store.getState().copy();
    store.getState().select([]);

    store.getState().paste();

    expect(ids(store.getState().flow)).toEqual(["outer", "inner", "P"]);
    expect(store.getState().message).toMatch(/^Can't paste: .*inside/);
  });

  it("copies notes along with nodes, under new note ids", () => {
    const store = loaded({
      ...flow([agent("A")], []),
      notes: [
        { id: "n1", text: "why", position: { x: 5, y: 5 }, size: { width: 160, height: 90 } },
      ],
    });
    store.getState().select(["A", "n1"]);

    store.getState().copy();
    store.getState().paste();

    expect(store.getState().flow.notes?.map((note) => note.id)).toEqual(["n1", "n2"]);
    expect(store.getState().flow.notes?.[1]).toMatchObject({
      text: "why",
      position: { x: 37, y: 37 },
    });
  });

  it("does nothing on paste before anything is copied, or on copy with nothing selected", () => {
    const store = loaded(chain());

    store.getState().paste();
    store.getState().copy();
    store.getState().paste();

    expect(ids(store.getState().flow)).toEqual(["A", "B", "C"]);
    expect(store.getState().undoStack).toEqual([]);
  });

  it("duplicates the selection in one step and leaves the copied items alone", () => {
    const store = loaded(chain());
    store.getState().select(["C"]);
    store.getState().copy();
    store.getState().select(["B"]);

    store.getState().duplicate();
    store.getState().paste();

    expect(ids(store.getState().flow)).toEqual(["A", "B", "C", "agent-1", "agent-2"]);
    expect(nodeOf(store.getState().flow, "agent-2")?.label).toBe("Fix");
  });
});

describe("frame only", () => {
  const loopWithBody = () =>
    flow(
      [
        {
          ...at(loop("L", { settings: { cap: 5, condition: "tests pass" } }), 0, 0),
          label: "Retry",
        },
        at(agent("P", { parent: "L" }), 0, 80),
        at(agent("S", { parent: "L" }), 200, 80),
      ],
      [thenWire("P", "S")],
    );

  const childrenOf = (current: Flow, id: string) =>
    current.nodes.filter((node) => node.parent === id).map((node) => node.id);

  it("adds an empty Loop with the same settings and label, and no body or wires", () => {
    const store = loaded(loopWithBody());
    const before = store.getState().flow;

    store.getState().frameOnly("L");

    const after = store.getState().flow;
    expect(ids(after)).toEqual(["L", "P", "S", "loop-1"]);
    expect(nodeOf(after, "loop-1")).toMatchObject({
      type: "loop",
      label: "Retry",
      settings: { cap: 5, condition: "tests pass", onCap: "fail" },
    });
    expect(nodeOf(after, "loop-1")?.parent).toBeUndefined();
    expect(childrenOf(after, "loop-1")).toEqual([]);
    expect(after.wires).toEqual(before.wires);
  });

  it("adds an empty For each, leaving out a frame nested in its body", () => {
    const store = loaded(
      flow(
        [
          at(forEach("F", { file: "units.md" }, "each unit"), 0, 0),
          at(agent("P", { parent: "F" }), 0, 80),
          at(loop("inner", { parent: "F" }), 0, 160),
          at(agent("Q", { parent: "inner" }), 0, 240),
        ],
        [thenWire("P", "inner")],
      ),
    );

    store.getState().frameOnly("F");

    const after = store.getState().flow;
    expect(ids(after)).toEqual(["F", "P", "inner", "Q", "foreach-1"]);
    expect(nodeOf(after, "foreach-1")).toMatchObject({
      type: "foreach",
      label: "each unit",
      settings: { file: "units.md" },
    });
    expect(childrenOf(after, "foreach-1")).toEqual([]);
    expect(ends(after)).toEqual(["P>inner"]);
  });

  it("is one undo step that removes the new frame and leaves the original as it was", () => {
    const store = loaded(loopWithBody());
    const before = store.getState().flow;

    store.getState().frameOnly("L");
    expect(store.getState().undoStack).toHaveLength(1);
    store.getState().undo();

    expect(store.getState().flow).toEqual(before);
  });

  it("leaves Duplicate copying the Loop with its body and wires", () => {
    const store = loaded(loopWithBody());
    store.getState().select(["L"]);

    store.getState().duplicate();

    const after = store.getState().flow;
    expect(ids(after)).toEqual(["L", "P", "S", "loop-1", "agent-1", "agent-2"]);
    expect(childrenOf(after, "loop-1")).toEqual(["agent-1", "agent-2"]);
    expect(ends(after)).toEqual(["P>S", "agent-1>agent-2"]);
  });
});

describe("inline rename", () => {
  it("renames the one selected node as one undo step", () => {
    const store = loaded(chain());
    store.getState().select(["B"]);

    store.getState().startRename();
    expect(store.getState().renaming).toBe("B");
    store.getState().rename("Run the tests");

    expect(nodeOf(store.getState().flow, "B")?.label).toBe("Run the tests");
    expect(store.getState().renaming).toBeNull();
    store.getState().undo();
    expect(nodeOf(store.getState().flow, "B")?.label).toBe("Test");
  });

  it("starts on a node given by id, as a double-click does", () => {
    const store = loaded(chain());

    store.getState().startRename("C");

    expect(store.getState().renaming).toBe("C");
    expect(store.getState().selection).toEqual(["C"]);
  });

  it("keeps the label when the new name is blank or the rename is cancelled", () => {
    const store = loaded(chain());
    store.getState().startRename("A");
    store.getState().rename("   ");
    store.getState().startRename("A");
    store.getState().cancelRename();

    expect(nodeOf(store.getState().flow, "A")?.label).toBe("Plan");
    expect(store.getState().undoStack).toEqual([]);
    expect(store.getState().renaming).toBeNull();
  });

  it("does not start without exactly one selected node", () => {
    const store = loaded(chain());
    store.getState().select(["A", "B"]);

    store.getState().startRename();

    expect(store.getState().renaming).toBeNull();
  });
});

describe("focusing a node from a problem", () => {
  it("selects the node and asks the canvas to centre it, each time it is asked", () => {
    const store = loaded(chain());

    store.getState().focusNode("B");
    const first = store.getState().focus;
    store.getState().focusNode("B");

    expect(store.getState().selection).toEqual(["B"]);
    expect(first?.node).toBe("B");
    expect(store.getState().focus?.node).toBe("B");
    expect(store.getState().focus?.seq).not.toBe(first?.seq);
  });

  it("counts each blueprint it loads, so the canvas fits each one once", () => {
    const store = createCanvasStore();
    const before = store.getState().opened;

    store.getState().load(chain());
    store.getState().load(chain());

    expect(store.getState().opened).toBe(before + 2);
  });
});

describe("selectNodeIssues", () => {
  it("lists every problem of a node, not only the first", () => {
    const current = flow(
      [
        at(fork("F"), 0, 0),
        { ...agent("X", { settings: { instructions: "" } }), parent: "nowhere" },
      ],
      [],
    );

    expect(selectNodeIssues(current)["X"]).toEqual([
      "Write what the agent should do.",
      expect.stringMatching(/nowhere/),
    ]);
  });
});

describe("selectSessionIssues", () => {
  it("maps each session field the validator names to its message", () => {
    expect(selectSessionIssues(newCanvasFlow())).toEqual({
      "buildConfig.repo":
        "Choose the repository this blueprint builds from, in the session settings. Build is refused until one is set.",
    });
  });

  it("is empty once the repository is set", () => {
    const base = newCanvasFlow();
    const set = {
      ...base,
      session: { ...base.session, buildConfig: { repo: "/w", variables: [] } },
    };

    expect(selectSessionIssues(set)).toEqual({});
  });
});
