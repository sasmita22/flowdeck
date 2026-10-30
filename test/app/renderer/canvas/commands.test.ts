import { describe, expect, it } from "vitest";
import {
  addNode,
  addWire,
  deleteNodes,
  moveNodes,
  updateSession,
  wrapInSession,
  type Command,
} from "../../../../src/app/renderer/canvas/commands.js";
import { flowsEqual } from "../../../../src/core/flow/equal.js";
import type { Flow, Node, Session, Wire } from "../../../../src/core/flow/schema.js";
import { flow, loop, prompt, script, thenWire } from "../../../fixtures/flow-builders.js";

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

const framed = (source: Flow, nodes: string[]): Flow => ({
  ...source,
  session: { ...source.session, frame: { nodes } },
});

const membersOf = (source: Flow) => source.session.frame?.nodes;

const loopWithBody = () =>
  flow([loop("L"), prompt("X", { parent: "L" }), prompt("A"), script("C")], []);

describe("wrapInSession", () => {
  it("frames the ids in selection order and undo leaves no frame key behind", () => {
    const before = fourNodes();

    const { after, restored } = roundTrip(wrapInSession(["C", "A", "D"]), before);

    expect(membersOf(after)).toEqual(["C", "A", "D"]);
    expect(after.nodes).toEqual(before.nodes);
    expect(after.wires).toEqual(before.wires);
    expect(restored).toEqual(before);
    expect(flowsEqual(restored, before)).toBe(true);
    expect(Object.hasOwn(restored.session, "frame")).toBe(false);
  });

  it("appends only ids that are not members yet and undo restores the previous members", () => {
    const before = framed(fourNodes(), ["A"]);

    const { after, restored } = roundTrip(wrapInSession(["B", "A", "C"]), before);

    expect(membersOf(after)).toEqual(["A", "B", "C"]);
    expect(membersOf(restored)).toEqual(["A"]);
    expect(flowsEqual(restored, before)).toBe(true);
  });

  it("ignores loop-body ids and ids that name no node", () => {
    const before = loopWithBody();

    const after = wrapInSession(["X", "A", "ghost", "L"]).do(before);

    expect(membersOf(after)).toEqual(["A", "L"]);
  });

  it("returns the flow unchanged when every id is ignored", () => {
    const before = loopWithBody();

    const { after, restored } = roundTrip(wrapInSession(["X", "ghost"]), before);

    expect(flowsEqual(after, before)).toBe(true);
    expect(Object.hasOwn(after.session, "frame")).toBe(false);
    expect(flowsEqual(restored, before)).toBe(true);
  });
});

describe("updateSession", () => {
  const edited = (source: Flow): Session => ({
    name: source.session.name,
    workingFolder: { kind: "worktree", branch: "dev", repo: "/r" },
    model: "haiku",
    allowedTools: ["Read"],
    permissionMode: source.session.permissionMode,
    connectors: source.session.connectors,
  });

  it("sets the session to the one given and changes nothing else", () => {
    const before = fourNodes();
    const next = edited(before);

    const after = updateSession(next).do(before);

    expect(after).toEqual({ ...before, session: next });
  });

  it("undo restores the previous session exactly, frame included", () => {
    const before = framed(fourNodes(), ["A", "B"]);

    const { after, restored } = roundTrip(updateSession(edited(before)), before);

    expect(Object.hasOwn(after.session, "frame")).toBe(false);
    expect(restored.session).toEqual(before.session);
    expect(flowsEqual(restored, before)).toBe(true);
  });
});

describe("commands", () => {
  const cases: [string, (before: Flow) => Command][] = [
    ["addNode", () => addNode(onlyNode(flow([script("E")], [])))],
    ["addWire", () => addWire(onlyWire(flow([prompt("C"), script("A")], [thenWire("C", "A")])))],
    ["deleteNodes", (before) => deleteNodes(before, ["B"])],
    ["moveNodes", () => moveNodes([{ id: "A", from: { x: 0, y: 0 }, to: { x: 3, y: 4 } }])],
    ["wrapInSession", () => wrapInSession(["A", "C"])],
    [
      "updateSession",
      (before) => updateSession({ ...before.session, model: "haiku", allowedTools: ["Read"] }),
    ],
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
