import { describe, expect, it } from "vitest";
import { mainFlow, mainFlowOnly } from "../../../src/core/flow/main-flow.js";
import {
  agent,
  flow,
  flowSettings,
  forEach,
  loop,
  output,
  sessionContainer,
  thenWire,
  trigger,
  workspaceContainer,
} from "../../fixtures/flow-builders.js";

const eventWire = (from: string, to: string) => ({
  kind: "event",
  from: { node: from, port: "out" },
  to: { node: to, port: "in" },
});

const reachedIds = (found: ReturnType<typeof mainFlow>) => [...(found?.reached ?? [])].sort();

const workspaceNodes = [trigger("ws-start"), output("ws-stop")];
const workspaceWire = thenWire("ws-start", "ws-stop");

const twoContainers = (sessionNodes: { id: string }[], sessionWires: unknown[]) =>
  flow([...workspaceNodes, ...sessionNodes], [workspaceWire, ...sessionWires], flowSettings, {
    containers: [
      workspaceContainer(["ws-start", "ws-stop"]),
      sessionContainer(sessionNodes.map((node) => node.id)),
    ],
  });

const oneSession = (nodes: { id: string; parent?: string }[], wires: unknown[]) =>
  flow(nodes, wires, flowSettings, {
    containers: [
      sessionContainer(nodes.filter((node) => node.parent === undefined).map((node) => node.id)),
    ],
  });

describe("mainFlow", () => {
  it("reaches what Start leads to and ignores the rest in node order", () => {
    const found = mainFlow(
      oneSession(
        [trigger("start"), agent("b"), agent("a"), agent("c"), output("stop"), agent("d")],
        [thenWire("start", "a"), thenWire("a", "stop"), thenWire("c", "d")],
      ),
    );

    expect(reachedIds(found)).toEqual(["a", "start", "stop"]);
    expect(found?.ignored.map((node) => node.id)).toEqual(["b", "c", "d"]);
  });

  it("is undefined with no containers", () => {
    const input = flow([agent("a"), output("stop")], [thenWire("a", "stop")], flowSettings, {
      containers: [],
    });

    expect(mainFlow(input)).toBeUndefined();
  });

  it("reaches a Loop frame through a wire into its body", () => {
    const found = mainFlow(
      oneSession(
        [
          trigger("start"),
          agent("a"),
          loop("l"),
          agent("x", { parent: "l" }),
          agent("y", { parent: "l" }),
          output("stop"),
        ],
        [thenWire("start", "a"), thenWire("a", "x"), thenWire("x", "y"), thenWire("y", "stop")],
      ),
    );

    expect(reachedIds(found)).toEqual(["a", "l", "start", "stop", "x", "y"]);
    expect(found?.ignored).toEqual([]);
  });

  it("reaches every body node through a wire into the frame", () => {
    const found = mainFlow(
      oneSession(
        [
          trigger("start"),
          loop("l"),
          agent("x", { parent: "l" }),
          agent("y", { parent: "l" }),
          output("stop"),
        ],
        [thenWire("start", "l"), thenWire("x", "y"), thenWire("l", "stop")],
      ),
    );

    expect(reachedIds(found)).toEqual(["l", "start", "stop", "x", "y"]);
  });

  it("reaches both nested frames and both bodies from an inner body node", () => {
    const found = mainFlow(
      oneSession(
        [
          trigger("start"),
          loop("outer"),
          agent("ox", { parent: "outer" }),
          loop("inner", { parent: "outer" }),
          agent("ix", { parent: "inner" }),
          agent("iy", { parent: "inner" }),
          output("stop"),
          agent("loose"),
        ],
        [thenWire("start", "ix"), thenWire("ix", "iy"), thenWire("outer", "stop")],
      ),
    );

    expect(reachedIds(found)).toEqual(["inner", "ix", "iy", "outer", "ox", "start", "stop"]);
    expect(found?.ignored.map((node) => node.id)).toEqual(["loose"]);
  });

  it("keeps the body of a For each frame on the main flow", () => {
    const found = mainFlow(
      oneSession(
        [trigger("start"), forEach("each"), agent("p", { parent: "each" }), output("stop")],
        [thenWire("start", "each"), thenWire("each", "stop")],
      ),
    );

    expect(reachedIds(found)).toEqual(["each", "p", "start", "stop"]);
  });

  it("does not follow event wires", () => {
    const found = mainFlow(
      oneSession(
        [trigger("start"), agent("a"), agent("b"), agent("c"), output("stop")],
        [thenWire("start", "a"), thenWire("a", "b"), eventWire("a", "c"), thenWire("b", "stop")],
      ),
    );

    expect(reachedIds(found)).toEqual(["a", "b", "start", "stop"]);
    expect(found?.ignored.map((node) => node.id)).toEqual(["c"]);
  });
});

describe("mainFlow per container", () => {
  it("joins what each container's Start reaches and ignores the rest", () => {
    const found = mainFlow(
      twoContainers(
        [trigger("start"), agent("a"), agent("b"), output("stop")],
        [thenWire("start", "a"), thenWire("a", "stop")],
      ),
    );

    expect(reachedIds(found)).toEqual(["a", "start", "stop", "ws-start", "ws-stop"]);
    expect(found?.ignored.map((node) => node.id)).toEqual(["b"]);
  });

  it.each([
    ["no Start", [agent("a"), output("stop")], [thenWire("a", "stop")]],
    [
      "two Starts",
      [trigger("one"), trigger("two"), agent("a"), output("stop")],
      [thenWire("one", "a"), thenWire("two", "a"), thenWire("a", "stop")],
    ],
  ])("takes nothing from a container with %s", (_, nodes, wires) => {
    const found = mainFlow(twoContainers(nodes, wires));

    expect(reachedIds(found)).toEqual(["ws-start", "ws-stop"]);
  });

  it("is undefined when no container has exactly one Start", () => {
    const input = flow(
      [trigger("one"), trigger("two"), agent("a"), output("stop"), output("ws-stop")],
      [thenWire("one", "a"), thenWire("a", "stop")],
      flowSettings,
      {
        containers: [
          workspaceContainer(["ws-stop"]),
          sessionContainer(["one", "two", "a", "stop"]),
        ],
      },
    );

    expect(mainFlow(input)).toBeUndefined();
  });
});

describe("mainFlowOnly", () => {
  it("keeps what every container's Start reaches", () => {
    const input = twoContainers(
      [trigger("start"), agent("a"), agent("b"), output("stop")],
      [thenWire("start", "a"), thenWire("a", "stop"), thenWire("b", "stop")],
    );

    const only = mainFlowOnly(input);

    expect(only.nodes.map((node) => node.id)).toEqual([
      "ws-start",
      "ws-stop",
      "start",
      "a",
      "stop",
    ]);
    expect(only.wires).toEqual([workspaceWire, thenWire("start", "a"), thenWire("a", "stop")]);
    expect(only.containers).toEqual(input.containers);
  });

  it("drops ignored nodes and every wire with an ignored end", () => {
    const input = oneSession(
      [trigger("start"), agent("a"), agent("b"), agent("c"), output("stop")],
      [thenWire("start", "a"), thenWire("a", "stop"), thenWire("b", "stop"), thenWire("b", "c")],
    );

    const only = mainFlowOnly(input);

    expect(only.nodes.map((node) => node.id)).toEqual(["start", "a", "stop"]);
    expect(only.wires).toEqual([thenWire("start", "a"), thenWire("a", "stop")]);
    expect(only.containers).toEqual(input.containers);
  });

  it.each([
    ["no Start", [agent("a"), loop("l"), agent("x", { parent: "l" }), output("stop")], []],
    [
      "two Starts",
      [
        trigger("one"),
        trigger("two"),
        agent("a"),
        loop("l"),
        agent("x", { parent: "l" }),
        output("stop"),
      ],
      [thenWire("one", "a")],
    ],
  ])(
    "keeps every member of a container with %s beside the others' reach",
    (_, sessionNodes, sessionWires) => {
      const members = sessionNodes.filter((node) => node.parent === undefined).map(({ id }) => id);
      const input = flow(
        [...workspaceNodes, agent("ws-stray"), ...sessionNodes],
        [workspaceWire, ...sessionWires],
        flowSettings,
        {
          containers: [
            workspaceContainer(["ws-start", "ws-stop", "ws-stray"]),
            sessionContainer(members),
          ],
        },
      );

      const only = mainFlowOnly(input);

      expect(only.nodes.map((node) => node.id)).toEqual([
        "ws-start",
        "ws-stop",
        ...sessionNodes.map(({ id }) => id),
      ]);
      expect(only.wires).toEqual([workspaceWire, ...sessionWires]);
      expect(only.containers).toEqual(input.containers);
    },
  );

  it("returns the flow unchanged when no container has exactly one Start", () => {
    const input = flow(
      [trigger("one"), trigger("two"), agent("a"), agent("b"), output("stop")],
      [thenWire("one", "a"), thenWire("a", "stop")],
      flowSettings,
      { containers: [sessionContainer(["one", "two", "a", "b", "stop"])] },
    );

    expect(mainFlowOnly(input)).toEqual(input);
  });
});
