import { describe, expect, it } from "vitest";
import {
  addConnection,
  addNode,
  addWire,
  deleteConnections,
  deleteFlowContainer,
  deleteNodes,
  moveNodes,
  updateFlowContainer,
  updateNode,
  addItems,
  deleteWires,
  type Command,
} from "../../../../src/app/renderer/canvas/commands.js";
import { flowsEqual } from "../../../../src/core/flow/equal.js";
import type { Connection, Flow, Node, Wire } from "../../../../src/core/flow/schema.js";
import {
  agent,
  flow,
  flowSettings,
  inOneSession,
  loop,
  output,
  sessionContainer,
  thenWire,
  trigger,
  workspaceContainer,
} from "../../../fixtures/flow-builders.js";

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
  inOneSession(
    [agent("A"), agent("B"), agent("C"), agent("D")],
    [thenWire("A", "B"), thenWire("A", "D"), thenWire("C", "B"), thenWire("B", "D")],
  );

const roundTrip = (command: Command, before: Flow) => {
  const after = command.do(before);
  return { after, restored: command.undo(after) };
};

describe("addNode", () => {
  it("appends the node and undo restores the original flow", () => {
    const before = flow([agent("A")], []);
    const node = onlyNode(flow([agent("E")], []));

    const { after, restored } = roundTrip(addNode(node), before);

    expect(after.nodes).toEqual([...before.nodes, node]);
    expect(after.wires).toEqual(before.wires);
    expect(after.containers).toEqual(before.containers);
    expect(restored).toEqual(before);
  });
});

describe("addWire", () => {
  it("appends the wire after the existing ones and undo restores the original flow", () => {
    const before = flow([agent("A"), agent("B"), agent("C")], [thenWire("A", "B")]);
    const wire = onlyWire(flow([agent("B"), agent("C")], [thenWire("B", "C")]));

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
    const before = inOneSession([agent("A"), agent("B"), agent("C")], [thenWire("A", "B")]);

    const { after, restored } = roundTrip(deleteNodes(before, ["C"]), before);

    expect(ids(after)).toEqual(["A", "B"]);
    expect(after.wires).toEqual(before.wires);
    expect(restored).toEqual(before);
  });

  it("removes the wires both into and out of a node in the middle of a chain", () => {
    const before = inOneSession(
      [agent("A"), agent("B"), agent("C")],
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
    const before = inOneSession([agent("A"), agent("B"), agent("C")], []);
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

  it("puts a moved node into a Loop body and undo takes it out again", () => {
    const before = flow([loop("L"), agent("A")], []);
    const command = moveNodes([
      { id: "A", from: { x: 0, y: 0 }, to: { x: 0, y: 80 }, parent: { from: undefined, to: "L" } },
    ]);

    const { after, restored } = roundTrip(command, before);

    expect(after.nodes[1]).toEqual({ ...before.nodes[1], position: { x: 0, y: 80 }, parent: "L" });
    expect(restored).toEqual(before);
    expect(restored.nodes[1]).not.toHaveProperty("parent");
  });

  it("takes a moved node out of its body, leaving no parent key, and undo puts it back", () => {
    const before = flow([loop("L"), agent("A", { parent: "L" })], []);
    const command = moveNodes([
      { id: "A", from: { x: 0, y: 0 }, to: { x: 400, y: 0 }, parent: { from: "L", to: undefined } },
    ]);

    const { after, restored } = roundTrip(command, before);

    expect(after.nodes[1]).not.toHaveProperty("parent");
    expect(after.nodes[1]?.position).toEqual({ x: 400, y: 0 });
    expect(restored).toEqual(before);
  });
});

describe("deleteWires", () => {
  it("removes only the wires at the given places and undo puts them back where they were", () => {
    const before = fourNodes();

    const { after, restored } = roundTrip(deleteWires(before, [3, 1]), before);

    expect(ends(after)).toEqual(["A>B", "C>B"]);
    expect(after.nodes).toEqual(before.nodes);
    expect(restored).toEqual(before);
  });

  it("leaves the flow alone for places that hold no wire", () => {
    const before = fourNodes();

    expect(deleteWires(before, [9]).do(before)).toEqual(before);
  });
});

describe("addItems", () => {
  it("adds nodes, wires and notes as one step and undo takes exactly them away", () => {
    const before = fourNodes();
    const pasted = inOneSession([agent("E"), agent("F")], [thenWire("E", "F")]);
    const note = {
      id: "n9",
      text: "copied",
      position: { x: 1, y: 2 },
      size: { width: 3, height: 4 },
    };

    const { after, restored } = roundTrip(
      addItems({ nodes: pasted.nodes, wires: pasted.wires, notes: [note] }),
      before,
    );

    expect(ids(after)).toEqual(["A", "B", "C", "D", "E", "F"]);
    expect(ends(after)).toEqual([...ends(before), "E>F"]);
    expect(after.notes).toEqual([note]);
    expect(restored).toEqual(before);
    expect(Object.hasOwn(restored, "notes")).toBe(false);
  });
});

describe("updateNode", () => {
  it("replaces one node's label and settings, and undo puts the old node back", () => {
    const before = fourNodes();
    const old = before.nodes[1];
    if (old === undefined) throw new Error("expected node B");
    const edited = { ...old, label: "Renamed", settings: { instructions: "New." } } as Node;

    const command = updateNode(edited);
    const after = command.do(before);

    expect(after.nodes[1]).toEqual(edited);
    expect(after.nodes.filter((_node, index) => index !== 1)).toEqual(
      before.nodes.filter((_node, index) => index !== 1),
    );
    expect(after.wires).toBe(before.wires);
    expect(command.undo(after)).toEqual(before);
    expect(command.do(command.undo(after))).toEqual(after);
  });

  it("leaves the flow alone when the node is gone", () => {
    const before = fourNodes();
    const command = updateNode({ ...onlyNode(before), id: "missing" });

    expect(command.undo(command.do(before))).toEqual(before);
  });
});

describe("commands", () => {
  const cases: [string, (before: Flow) => Command][] = [
    ["addNode", () => addNode(onlyNode(flow([agent("E")], [])))],
    ["addWire", () => addWire(onlyWire(flow([agent("C"), agent("A")], [thenWire("C", "A")])))],
    ["deleteNodes", (before) => deleteNodes(before, ["B"])],
    ["moveNodes", () => moveNodes([{ id: "A", from: { x: 0, y: 0 }, to: { x: 3, y: 4 } }])],
    ["deleteWires", (before) => deleteWires(before, [0, 2])],
    [
      "addItems",
      () => addItems({ nodes: [onlyNode(flow([agent("E")], []))], wires: [], notes: [] }),
    ],
    ["updateFlowContainer", () => updateFlowContainer("session-1", { repo: "/r", model: "haiku" })],
    ["deleteFlowContainer", (before) => deleteFlowContainer(before, "session-1")],
    [
      "moveNodes into a container",
      () =>
        moveNodes([
          {
            id: "A",
            from: { x: 0, y: 0 },
            to: { x: 3, y: 4 },
            container: { from: "session-1", to: "workspace-1" },
          },
        ]),
    ],
    ["updateNode", (before) => updateNode({ ...onlyNode(before), label: "Renamed" })],
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

const containerOf = (source: Flow, id: string) =>
  source.containers.find((container) => container.id === id);

const twoSessions = () =>
  flow(
    [
      trigger("w-start"),
      output("w-stop"),
      trigger("s"),
      loop("L"),
      agent("P", { parent: "L" }),
      output("t"),
      trigger("u"),
      agent("v"),
      output("x"),
    ],
    [
      thenWire("w-start", "w-stop"),
      thenWire("s", "L"),
      thenWire("L", "t"),
      thenWire("v", "x"),
      thenWire("u", "v"),
      thenWire("P", "v"),
    ],
    flowSettings,
    {
      containers: [
        workspaceContainer(["w-start", "w-stop"]),
        sessionContainer(["s", "L", "t"]),
        sessionContainer(["u", "v", "x"], { id: "session-2", name: "web" }),
      ],
    },
  );

describe("addItems with a container", () => {
  it("adds the container with its Start, Stop and wire, and undo takes all of them away", () => {
    const before = twoSessions();
    const pasted = flow([trigger("s3"), output("t3")], [thenWire("s3", "t3")], flowSettings, {
      containers: [sessionContainer(["s3", "t3"], { id: "session-3", name: "api" })],
    });

    const { after, restored } = roundTrip(
      addItems({
        nodes: pasted.nodes,
        wires: pasted.wires,
        notes: [],
        containers: pasted.containers,
      }),
      before,
    );

    expect(after.containers).toEqual([...before.containers, ...pasted.containers]);
    expect(ids(after)).toEqual([...ids(before), "s3", "t3"]);
    expect(ends(after)).toEqual([...ends(before), "s3>t3"]);
    expect(restored).toEqual(before);
  });
});

describe("deleteFlowContainer", () => {
  it("removes the container, its members, their body nodes and every wire on them as one command", () => {
    const before = twoSessions();

    const after = deleteFlowContainer(before, "session-1").do(before);

    expect(after.containers.map(({ id }) => id)).toEqual(["workspace-1", "session-2"]);
    expect(ids(after)).toEqual(["w-start", "w-stop", "u", "v", "x"]);
    expect(ends(after)).toEqual(["w-start>w-stop", "v>x", "u>v"]);
  });

  it("undo restores the flow exactly", () => {
    const before = twoSessions();

    const { restored } = roundTrip(deleteFlowContainer(before, "session-1"), before);

    expect(restored).toEqual(before);
    expect(flowsEqual(restored, before)).toBe(true);
  });

  it("leaves the flow alone for an id that names no container", () => {
    const before = twoSessions();

    expect(deleteFlowContainer(before, "session-9").do(before)).toEqual(before);
  });
});

describe("deleteNodes and container members", () => {
  it("takes a deleted Start off its container's members and keeps the container", () => {
    const before = twoSessions();

    const { after, restored } = roundTrip(deleteNodes(before, ["s"]), before);

    expect(containerOf(after, "session-1")?.nodes).toEqual(["L", "t"]);
    expect(containerOf(after, "session-2")?.nodes).toEqual(["u", "v", "x"]);
    expect(restored).toEqual(before);
  });

  it("removes a container whose last member is deleted, and undo brings it back in its place", () => {
    const before = twoSessions();

    const { after, restored } = roundTrip(deleteNodes(before, ["s", "L", "P", "t"]), before);

    expect(after.containers.map(({ id }) => id)).toEqual(["workspace-1", "session-2"]);
    expect(restored).toEqual(before);
    expect(restored.containers.map(({ id }) => id)).toEqual([
      "workspace-1",
      "session-1",
      "session-2",
    ]);
  });

  it("leaves the member lists alone when a body node is deleted", () => {
    const before = twoSessions();

    const after = deleteNodes(before, ["P"]).do(before);

    expect(after.containers).toEqual(before.containers);
  });
});

describe("updateFlowContainer", () => {
  it("changes only the named container's settings", () => {
    const before = twoSessions();

    const after = updateFlowContainer("session-2", { repo: "/r", branch: "dev" }).do(before);

    expect(containerOf(after, "session-2")).toEqual({
      ...containerOf(before, "session-2"),
      repo: "/r",
      branch: "dev",
    });
    expect(after).toEqual({
      ...before,
      containers: before.containers.map((container) =>
        container.id === "session-2" ? { ...container, repo: "/r", branch: "dev" } : container,
      ),
    });
  });

  it("sets the workspace's model", () => {
    const before = twoSessions();

    const after = updateFlowContainer("workspace-1", { model: "haiku" }).do(before);

    expect(containerOf(after, "workspace-1")).toEqual({
      ...containerOf(before, "workspace-1"),
      model: "haiku",
    });
  });

  it("undo restores the previous settings exactly", () => {
    const before = twoSessions();

    const { restored } = roundTrip(
      updateFlowContainer("session-1", { name: "api", repo: "/r", branch: "dev", model: "opus" }),
      before,
    );

    expect(restored).toEqual(before);
  });

  it("leaves the flow alone for an id that names no container", () => {
    const before = twoSessions();

    expect(updateFlowContainer("session-9", { repo: "/r" }).do(before)).toEqual(before);
  });

  it("clears the branch when the repo changes, and undo brings the branch back", () => {
    const before = twoSessions();

    const { after, restored } = roundTrip(
      updateFlowContainer("session-1", { repo: "/other" }),
      before,
    );

    expect(containerOf(after, "session-1")).toMatchObject({ repo: "/other", branch: "" });
    expect(restored).toEqual(before);
  });

  it("keeps the branch when the repo is set to the one it already has", () => {
    const before = twoSessions();

    const after = updateFlowContainer("session-1", { repo: "/work/repo" }).do(before);

    expect(containerOf(after, "session-1")).toMatchObject({ branch: "main" });
  });
});

describe("moveNodes across container frames", () => {
  const at = { x: 0, y: 0 };

  it("moves a member from one container to another in the same command, and undo puts it back in its place", () => {
    const before = twoSessions();
    const command = moveNodes([
      {
        id: "L",
        from: at,
        to: { x: 900, y: 0 },
        container: { from: "session-1", to: "session-2" },
      },
    ]);

    const { after, restored } = roundTrip(command, before);

    expect(containerOf(after, "session-1")?.nodes).toEqual(["s", "t"]);
    expect(containerOf(after, "session-2")?.nodes).toEqual(["u", "v", "x", "L"]);
    expect(after.nodes.find(({ id }) => id === "L")?.position).toEqual({ x: 900, y: 0 });
    expect(restored).toEqual(before);
  });

  it("adds a node carried into a container from outside every container", () => {
    const loose = flow([agent("y")], [], flowSettings, {
      containers: [sessionContainer(["s", "t"])],
    });
    const before = { ...twoSessions(), nodes: [...twoSessions().nodes, ...loose.nodes] };
    const command = moveNodes([
      { id: "y", from: at, to: { x: 10, y: 10 }, container: { from: undefined, to: "session-1" } },
    ]);

    const { after, restored } = roundTrip(command, before);

    expect(containerOf(after, "session-1")?.nodes).toEqual(["s", "L", "t", "y"]);
    expect(restored).toEqual(before);
  });

  it("takes a node carried out of every container off its members", () => {
    const before = twoSessions();
    const command = moveNodes([
      { id: "v", from: at, to: { x: 2000, y: 0 }, container: { from: "session-2", to: undefined } },
    ]);

    const { after, restored } = roundTrip(command, before);

    expect(containerOf(after, "session-2")?.nodes).toEqual(["u", "x"]);
    expect(after.containers.flatMap(({ nodes }) => nodes)).not.toContain("v");
    expect(restored).toEqual(before);
  });

  it("removes a container whose last member is carried out of its frame, and undo brings it back in its place", () => {
    const before = twoSessions();
    const command = moveNodes(
      ["u", "v", "x"].map((id) => ({
        id,
        from: at,
        to: { x: 2000, y: 0 },
        container: { from: "session-2", to: "session-1" },
      })),
    );

    const { after, restored } = roundTrip(command, before);

    expect(after.containers.map(({ id }) => id)).toEqual(["workspace-1", "session-1"]);
    expect(containerOf(after, "session-1")?.nodes).toEqual(["s", "L", "t", "u", "v", "x"]);
    expect(restored).toEqual(before);
  });

  it("leaves membership alone for a move with no container change", () => {
    const before = twoSessions();

    const after = moveNodes([{ id: "v", from: at, to: { x: 5, y: 5 } }]).do(before);

    expect(after.containers).toEqual(before.containers);
  });
});

describe("connections", () => {
  const at = { x: 0, y: 0 };
  const androidIos: Connection = { id: "c1", between: ["android", "ios"] };
  const androidWeb: Connection = { id: "c2", between: ["web", "android"] };
  const iosWeb: Connection = { id: "c3", between: ["ios", "web"] };

  const threeSessions = (connections?: Connection[]): Flow => {
    const base = flow(
      [
        trigger("w-start"),
        output("w-stop"),
        trigger("a1"),
        output("a2"),
        trigger("i1"),
        output("i2"),
        trigger("b1"),
        output("b2"),
      ],
      [
        thenWire("w-start", "w-stop"),
        thenWire("a1", "a2"),
        thenWire("i1", "i2"),
        thenWire("b1", "b2"),
      ],
      flowSettings,
      {
        containers: [
          workspaceContainer(["w-start", "w-stop"]),
          sessionContainer(["a1", "a2"], { id: "android", name: "android" }),
          sessionContainer(["i1", "i2"], { id: "ios", name: "ios" }),
          sessionContainer(["b1", "b2"], { id: "web", name: "web" }),
        ],
      },
    );
    return connections === undefined ? base : { ...base, connections };
  };

  const connectionIds = (source: Flow) => source.connections?.map(({ id }) => id);

  it("addConnection adds the connection, and undo leaves no connections key", () => {
    const before = threeSessions();

    const { after, restored } = roundTrip(addConnection(androidIos), before);

    expect(after.connections).toEqual([androidIos]);
    expect(restored).toEqual(before);
    expect(restored).not.toHaveProperty("connections");
  });

  it("addConnection appends after the existing ones, and undo takes only it away", () => {
    const before = threeSessions([androidWeb]);

    const { after, restored } = roundTrip(addConnection(androidIos), before);

    expect(connectionIds(after)).toEqual(["c2", "c1"]);
    expect(restored).toEqual(before);
  });

  it("deleteConnections removes the given ids, and undo puts them back in place", () => {
    const before = threeSessions([androidIos, androidWeb, iosWeb]);

    const { after, restored } = roundTrip(deleteConnections(before, ["c1", "c3"]), before);

    expect(connectionIds(after)).toEqual(["c2"]);
    expect(restored).toEqual(before);
  });

  it("deleteConnections of the last one leaves no connections key", () => {
    const before = threeSessions([androidIos]);

    const after = deleteConnections(before, ["c1"]).do(before);

    expect(after).not.toHaveProperty("connections");
  });

  it("deleteFlowContainer removes the container's connections, and one undo restores both", () => {
    const before = threeSessions([androidIos, androidWeb]);

    const { after, restored } = roundTrip(deleteFlowContainer(before, "ios"), before);

    expect(after.containers.map(({ id }) => id)).not.toContain("ios");
    expect(connectionIds(after)).toEqual(["c2"]);
    expect(restored).toEqual(before);
  });

  it("deleting every node of a container removes its connections, and one undo restores them", () => {
    const before = threeSessions([androidWeb, androidIos, iosWeb]);

    const { after, restored } = roundTrip(deleteNodes(before, ["i1", "i2"]), before);

    expect(after.containers.map(({ id }) => id)).not.toContain("ios");
    expect(connectionIds(after)).toEqual(["c2"]);
    expect(restored).toEqual(before);
  });

  it("deleting a container's only connection leaves no connections key", () => {
    const before = threeSessions([androidIos]);

    const after = deleteFlowContainer(before, "ios").do(before);

    expect(after).not.toHaveProperty("connections");
  });

  it("moving every node out of a container removes its connections, and undo restores them", () => {
    const before = threeSessions([androidIos, androidWeb]);
    const command = moveNodes(
      ["i1", "i2"].map((id) => ({
        id,
        from: at,
        to: { x: 2000, y: 0 },
        container: { from: "ios", to: "web" },
      })),
    );

    const { after, restored } = roundTrip(command, before);

    expect(after.containers.map(({ id }) => id)).not.toContain("ios");
    expect(connectionIds(after)).toEqual(["c2"]);
    expect(restored).toEqual(before);
  });

  it("keeps the connections of a container that is not removed", () => {
    const before = threeSessions([androidIos, androidWeb]);

    const deleted = deleteNodes(before, ["i1"]).do(before);
    const moved = moveNodes([
      { id: "i1", from: at, to: at, container: { from: "ios", to: "web" } },
    ]).do(before);

    expect(deleted.connections).toEqual(before.connections);
    expect(moved.connections).toEqual(before.connections);
  });
});
