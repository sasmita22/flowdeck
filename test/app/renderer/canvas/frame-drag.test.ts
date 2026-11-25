import { describe, expect, it } from "vitest";
import { flowContainerBounds } from "../../../../src/app/renderer/canvas/frames.js";
import { createCanvasStore } from "../../../../src/app/renderer/canvas/store.js";
import { toViewNodes } from "../../../../src/app/renderer/canvas/view.js";
import type { Flow } from "../../../../src/core/flow/schema.js";
import {
  agent,
  flow,
  flowSettings,
  loop,
  output,
  sessionContainer,
  thenWire,
  trigger,
  workspaceContainer,
} from "../../../fixtures/flow-builders.js";

const at = <N extends object>(node: N, x: number, y: number) => ({ ...node, position: { x, y } });

const library = (id: string) => ({
  id,
  label: id,
  position: { x: 0, y: 0 },
  type: "library",
  settings: { libraryId: "shared", label: "Shared", overrides: {} },
});

const canvas = (): Flow =>
  flow(
    [
      at(trigger("w-start"), 0, 0),
      at(output("w-stop"), 300, 0),
      at(trigger("s"), 0, 300),
      at(agent("a"), 200, 300),
      at(loop("L"), 500, 300),
      at(agent("p", { parent: "L" }), 500, 400),
      at(library("lib"), 800, 300),
      at(output("t"), 1100, 300),
      at(trigger("s2"), 0, 800),
      at(output("t2"), 300, 800),
      at(agent("loose"), 0, 1200),
    ],
    [thenWire("s", "a"), thenWire("a", "L"), thenWire("L", "lib"), thenWire("lib", "t")],
    flowSettings,
    {
      containers: [
        workspaceContainer(["w-start", "w-stop"]),
        sessionContainer(["s", "a", "L", "lib", "t"]),
        sessionContainer(["s2", "t2"], { id: "session-2", name: "other" }),
      ],
    },
  );

const loaded = (current: Flow) => {
  const store = createCanvasStore();
  store.getState().load(current);
  return store;
};

type Store = ReturnType<typeof loaded>;

const frameId = (container: string) => `container-frame-${container}`;

const dragFrame = (store: Store, container: string, dx: number, dy: number) => {
  const { left, top } = flowContainerBounds(store.getState().flow, container);
  store.getState().dragTo(frameId(container), { x: left + dx, y: top + dy });
  store.getState().endDrag([frameId(container)]);
};

const positions = (current: Flow) =>
  Object.fromEntries(current.nodes.map(({ id, position }) => [id, position]));

const shifted = (current: Flow, ids: readonly string[], dx: number, dy: number) => {
  const moved = new Set(ids);
  return Object.fromEntries(
    current.nodes.map(({ id, position: { x, y } }) => [
      id,
      moved.has(id) ? { x: x + dx, y: y + dy } : { x, y },
    ]),
  );
};

const sessionNodes = ["s", "a", "L", "p", "lib", "t"];

describe("dragging a container's frame", () => {
  it("moves every node of a session by the drag offset, and nothing else, as one undo step", () => {
    const store = loaded(canvas());
    const before = store.getState().flow;
    const undoDepth = store.getState().undoStack.length;

    dragFrame(store, "session-1", 130, 70);

    const after = store.getState().flow;
    expect(positions(after)).toEqual(shifted(before, sessionNodes, 130, 70));
    expect(after.containers).toEqual(before.containers);
    expect(after.wires).toEqual(before.wires);
    expect(after.nodes.find(({ id }) => id === "p")?.parent).toBe("L");
    expect(store.getState().undoStack).toHaveLength(undoDepth + 1);
    expect(store.getState().dragPositions).toEqual({});

    store.getState().undo();

    expect(store.getState().flow).toEqual(before);
  });

  it("moves a workspace's nodes and leaves the session beside it untouched", () => {
    const store = loaded(canvas());
    const before = store.getState().flow;

    dragFrame(store, "workspace-1", -40, 90);

    expect(positions(store.getState().flow)).toEqual(
      shifted(before, ["w-start", "w-stop"], -40, 90),
    );
    expect(flowContainerBounds(store.getState().flow, "session-1")).toEqual(
      flowContainerBounds(before, "session-1"),
    );

    store.getState().undo();

    expect(store.getState().flow).toEqual(before);
  });

  it("keeps a session's nodes in it when its frame is dropped over another session", () => {
    const store = loaded(canvas());
    const before = store.getState().flow;
    const other = flowContainerBounds(before, "session-2");
    const own = flowContainerBounds(before, "session-1");

    dragFrame(store, "session-1", other.left - own.left, other.top - own.top);

    expect(store.getState().flow.containers).toEqual(before.containers);
    expect(store.getState().flow.nodes.map(({ parent }) => parent)).toEqual(
      before.nodes.map(({ parent }) => parent),
    );
  });

  it("still moves only the node dragged inside a frame", () => {
    const store = loaded(canvas());
    const before = store.getState().flow;

    store.getState().dragTo("a", { x: 230, y: 340 });
    store.getState().endDrag(["a"]);

    expect(positions(store.getState().flow)).toEqual(shifted(before, ["a"], 30, 40));
    expect(store.getState().flow.containers).toEqual(before.containers);
  });

  it("draws the frame and its nodes at the live drag offset, and no other frame", () => {
    const source = canvas();
    const own = flowContainerBounds(source, "session-1");
    const live = { [frameId("session-1")]: { x: own.left + 25, y: own.top - 15 } };

    const view = Object.fromEntries(
      toViewNodes(source, [], live, null).map((node) => [node.id, node]),
    );
    const still = Object.fromEntries(
      toViewNodes(source, [], {}, null).map((node) => [node.id, node]),
    );

    expect(view[frameId("session-1")]?.position).toEqual({ x: own.left + 25, y: own.top - 15 });
    for (const id of sessionNodes) {
      const { x, y } = still[id]?.position ?? { x: NaN, y: NaN };
      expect(view[id]?.position).toEqual({ x: x + 25, y: y - 15 });
    }
    expect(view["loop-frame-L"]?.position).toEqual({
      x: (still["loop-frame-L"]?.position.x ?? NaN) + 25,
      y: (still["loop-frame-L"]?.position.y ?? NaN) - 15,
    });
    for (const id of [frameId("workspace-1"), frameId("session-2"), "s2", "loose"]) {
      expect(view[id]?.position).toEqual(still[id]?.position);
    }
  });
});
