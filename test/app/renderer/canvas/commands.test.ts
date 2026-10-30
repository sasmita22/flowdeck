import { describe, expect, it } from "vitest";
import {
  addNode,
  addWire,
  deleteNodes,
  moveNodes,
  setWorkingFolder,
  type Command,
} from "../../../../src/app/renderer/canvas/commands.js";
import type { Flow, Node, Wire } from "../../../../src/core/flow/schema.js";
import { flow, prompt, script, thenWire } from "../../../fixtures/flow-builders.js";

const deepFreeze = <T>(value: T): T => {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

const onlyNode = (source: Flow): Node => {
  const [node] = source.nodes;
  if (node === undefined) throw new Error("flow has no node");
  return node;
};

const onlyWire = (source: Flow): Wire => {
  const [wire] = source.wires;
  if (wire === undefined) throw new Error("flow has no wire");
  return wire;
};

const ids = (source: Flow) => source.nodes.map((node) => node.id);
const ends = (source: Flow) => source.wires.map((wire) => `${wire.from.node}>${wire.to.node}`);

const fourNodes = () =>
  flow(
    [prompt("A"), prompt("B"), script("C"), script("D")],
    [thenWire("A", "B"), thenWire("A", "D"), thenWire("C", "B"), thenWire("B", "D")],
  );

const roundTrip = (command: Command, before: Flow) => {
  const after = command.do(before);
  return { after, restored: command.undo(after) };
};

describe("addNode", () => {
  it("appends the node and undo restores the original flow", () => {
    const before = flow([prompt("A")], []);
    const node = onlyNode(flow([script("E")], []));

    const { after, restored } = roundTrip(addNode(node), before);

    expect(after.nodes).toEqual([...before.nodes, node]);
    expect(after.wires).toEqual(before.wires);
    expect(after.session).toEqual(before.session);
    expect(restored).toEqual(before);
  });
});

describe("addWire", () => {
  it("appends the wire after the existing ones and undo restores the original flow", () => {
    const before = flow([prompt("A"), prompt("B"), script("C")], [thenWire("A", "B")]);
    const wire = onlyWire(flow([prompt("B"), script("C")], [thenWire("B", "C")]));

    const { after, restored } = roundTrip(addWire(wire), before);

    expect(after.wires).toEqual([...before.wires, wire]);
    expect(after.nodes).toEqual(before.nodes);
    expect(restored).toEqual(before);
  });
});

describe("deleteNodes", () => {
  it("removes a node with three wires and undo puts all four back at their indexes", () => {
    const before = fourNodes();
    const command = deleteNodes(before, ["B"]);

    const { after, restored } = roundTrip(command, before);

    expect(ids(after)).toEqual(["A", "C", "D"]);
    expect(ends(after)).toEqual(["A>D"]);
    expect(after.nodes.length + after.wires.length).toBe(
      before.nodes.length + before.wires.length - 4,
    );
    expect(restored).toEqual(before);
    expect(restored.nodes[1]?.id).toBe("B");
    expect(ends(restored)).toEqual(["A>B", "A>D", "C>B", "B>D"]);
  });

  it("removes a wire shared by two deleted nodes once and undo restores it once", () => {
    const before = fourNodes();

    const { after, restored } = roundTrip(deleteNodes(before, ["A", "B"]), before);

    expect(ids(after)).toEqual(["C", "D"]);
    expect(after.wires).toEqual([]);
    expect(restored).toEqual(before);
    expect(ends(restored).filter((end) => end === "A>B")).toHaveLength(1);
  });

  it("removes a node with no wires and leaves the wires alone", () => {
    const before = flow([prompt("A"), prompt("B"), script("C")], [thenWire("A", "B")]);

    const { after, restored } = roundTrip(deleteNodes(before, ["C"]), before);

    expect(ids(after)).toEqual(["A", "B"]);
    expect(after.wires).toEqual(before.wires);
    expect(restored).toEqual(before);
  });

  it("removes the wires both into and out of a node in the middle of a chain", () => {
    const before = flow(
      [prompt("A"), prompt("B"), script("C")],
      [thenWire("A", "B"), thenWire("B", "C")],
    );

    const { after, restored } = roundTrip(deleteNodes(before, ["B"]), before);

    expect(ids(after)).toEqual(["A", "C"]);
    expect(after.wires).toEqual([]);
    expect(restored).toEqual(before);
  });
});

describe("moveNodes", () => {
  it("sets each moved node to its new position and undo sets it back, leaving others alone", () => {
    const before = flow([prompt("A"), prompt("B"), script("C")], []);
    const command = moveNodes([
      { id: "A", from: { x: 0, y: 0 }, to: { x: 10, y: 20 } },
      { id: "C", from: { x: 0, y: 0 }, to: { x: -5, y: 7.5 } },
    ]);

    const { after, restored } = roundTrip(command, before);

    expect(after.nodes.map((node) => node.position)).toEqual([
      { x: 10, y: 20 },
      { x: 0, y: 0 },
      { x: -5, y: 7.5 },
    ]);
    expect(after.nodes[1]).toEqual(before.nodes[1]);
    expect(restored).toEqual(before);
  });
});

describe("setWorkingFolder", () => {
  const withFolder = (source: Flow, workingFolder: Flow["session"]["workingFolder"]): Flow => ({
    ...source,
    session: { ...source.session, workingFolder },
  });

  it("sets a path working folder over a worktree and changes nothing else", () => {
    const before = fourNodes();

    const after = setWorkingFolder("/tmp/x").do(before);

    expect(after).toEqual(withFolder(before, { kind: "path", path: "/tmp/x" }));
  });

  it("undo restores the worktree it replaced exactly", () => {
    const before = fourNodes();

    const { restored } = roundTrip(setWorkingFolder("/tmp/x"), before);

    expect(restored).toEqual(before);
    expect(restored.session.workingFolder).toEqual({ kind: "worktree", branch: "main" });
  });

  it("undo restores an earlier path exactly", () => {
    const before = withFolder(fourNodes(), { kind: "path", path: "/tmp/earlier" });

    const { after, restored } = roundTrip(setWorkingFolder("/tmp/x"), before);

    expect(after.session.workingFolder).toEqual({ kind: "path", path: "/tmp/x" });
    expect(restored).toEqual(before);
  });
});

describe("commands", () => {
  const cases: [string, (before: Flow) => Command][] = [
    ["addNode", () => addNode(onlyNode(flow([script("E")], [])))],
    ["addWire", () => addWire(onlyWire(flow([prompt("C"), script("A")], [thenWire("C", "A")])))],
    ["deleteNodes", (before) => deleteNodes(before, ["B"])],
    ["moveNodes", () => moveNodes([{ id: "A", from: { x: 0, y: 0 }, to: { x: 3, y: 4 } }])],
    ["setWorkingFolder", () => setWorkingFolder("/tmp/x")],
  ];

  it.each(cases)("%s never mutates the flow it is given", (_name, make) => {
    const before = fourNodes();
    const snapshot = structuredClone(before);
    const command = make(before);

    const after = command.do(deepFreeze(before));
    const restored = command.undo(deepFreeze(after));

    expect(before).toEqual(snapshot);
    expect(restored).toEqual(snapshot);
  });
});
