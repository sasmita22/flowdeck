import { describe, expect, it } from "vitest";
import { mainFlow, mainFlowOnly } from "../../../src/core/flow/main-flow.js";
import {
  agent,
  flow,
  flowSettings,
  loop,
  output,
  sessionContainer,
  thenWire,
  trigger,
  wire,
  workspaceContainer,
} from "../../fixtures/flow-builders.js";
import { libraryOf } from "../../fixtures/known-library.js";

const eventWire = (from: string, to: string) => ({
  kind: "event",
  from: { node: from, port: "out" },
  to: { node: to, port: "in" },
});

const reachedIds = (found: ReturnType<typeof mainFlow>) => [...(found?.reached ?? [])].sort();
const containerIds = (found: ReturnType<typeof mainFlow>) => [...(found?.containers ?? [])].sort();

const canvasStart = trigger("canvas-start");
const canvasStop = output("canvas-stop");
const intoContainer = (from: string, container: string) => wire(from, "out", container, "flow-in");
const outOfContainer = (container: string, to: string) => wire(container, "flow-out", to, "in");
const throughSession = [
  intoContainer("canvas-start", "session-1"),
  outOfContainer("session-1", "canvas-stop"),
];

const workspaceNodes = [trigger("ws-start"), output("ws-stop")];
const workspaceWire = thenWire("ws-start", "ws-stop");

const looseLibrary = (id: string, libraryId: string) => ({
  id,
  type: "library",
  label: "Library",
  position: { x: 0, y: 0 },
  settings: { libraryId, label: libraryId, overrides: {} },
});

const workflowWithLoose = (...loose: ReturnType<typeof looseLibrary>[]) =>
  flow(
    [canvasStart, ...workspaceNodes, ...loose, canvasStop],
    [
      intoContainer("canvas-start", "workspace-1"),
      outOfContainer("workspace-1", "canvas-stop"),
      workspaceWire,
    ],
    flowSettings,
    { containers: [workspaceContainer(["ws-start", "ws-stop"])] },
  );

const twoContainers = (sessionNodes: { id: string }[], sessionWires: unknown[]) =>
  flow([...workspaceNodes, ...sessionNodes], [workspaceWire, ...sessionWires], flowSettings, {
    containers: [
      workspaceContainer(["ws-start", "ws-stop"]),
      sessionContainer(sessionNodes.map((node) => node.id)),
    ],
  });

const oneSession = (nodes: { id: string; parent?: string }[], wires: unknown[]) =>
  flow([canvasStart, ...nodes, canvasStop], [...throughSession, ...wires], flowSettings, {
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

    expect(reachedIds(found)).toEqual(["a", "canvas-start", "canvas-stop", "start", "stop"]);
    expect(found?.ignored.map((node) => node.id)).toEqual(["b", "c", "d"]);
  });

  it("is undefined with no workspace and no canvas Start", () => {
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

    expect(reachedIds(found)).toEqual([
      "a",
      "canvas-start",
      "canvas-stop",
      "l",
      "start",
      "stop",
      "x",
      "y",
    ]);
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

    expect(reachedIds(found)).toEqual([
      "canvas-start",
      "canvas-stop",
      "l",
      "start",
      "stop",
      "x",
      "y",
    ]);
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

    expect(reachedIds(found)).toEqual([
      "canvas-start",
      "canvas-stop",
      "inner",
      "ix",
      "iy",
      "outer",
      "ox",
      "start",
      "stop",
    ]);
    expect(found?.ignored.map((node) => node.id)).toEqual(["loose"]);
  });

  it("does not follow event wires", () => {
    const found = mainFlow(
      oneSession(
        [trigger("start"), agent("a"), agent("b"), agent("c"), output("stop")],
        [thenWire("start", "a"), thenWire("a", "b"), eventWire("a", "c"), thenWire("b", "stop")],
      ),
    );

    expect(reachedIds(found)).toEqual(["a", "b", "canvas-start", "canvas-stop", "start", "stop"]);
    expect(found?.ignored.map((node) => node.id)).toEqual(["c"]);
  });
});

describe("mainFlow from the canvas Start", () => {
  const sessionBeside = [trigger("s-start"), output("s-stop")];
  const sessionBesideWire = thenWire("s-start", "s-stop");

  it("reaches the canvas path and ignores an unwired session without a workspace", () => {
    const found = mainFlow(
      flow(
        [canvasStart, agent("a"), canvasStop, ...sessionBeside],
        [thenWire("canvas-start", "a"), thenWire("a", "canvas-stop"), sessionBesideWire],
        flowSettings,
        { containers: [sessionContainer(["s-start", "s-stop"])] },
      ),
    );

    expect(reachedIds(found)).toEqual(["a", "canvas-start", "canvas-stop"]);
    expect(found?.ignored.map((node) => node.id)).toEqual(["s-start", "s-stop"]);
    expect(containerIds(found)).toEqual([]);
  });

  it("steps into a session through its flow-in and on through its flow-out", () => {
    const found = mainFlow(
      flow(
        [canvasStart, ...sessionBeside, canvasStop],
        [...throughSession, sessionBesideWire],
        flowSettings,
        { containers: [sessionContainer(["s-start", "s-stop"])] },
      ),
    );

    expect(reachedIds(found)).toEqual(["canvas-start", "canvas-stop", "s-start", "s-stop"]);
    expect(found?.ignored).toEqual([]);
    expect(containerIds(found)).toEqual(["session-1"]);
  });

  it("is undefined for a session alone with no canvas Start", () => {
    const input = flow(sessionBeside, [sessionBesideWire], flowSettings, {
      containers: [sessionContainer(["s-start", "s-stop"])],
    });

    expect(mainFlow(input)).toBeUndefined();
  });

  it("is undefined with two canvas Starts and no workspace", () => {
    const input = flow(
      [canvasStart, trigger("other-start"), agent("a"), canvasStop],
      [thenWire("canvas-start", "a"), thenWire("other-start", "a"), thenWire("a", "canvas-stop")],
      flowSettings,
      { containers: [] },
    );

    expect(mainFlow(input)).toBeUndefined();
  });

  it("adds the canvas Start and Stop to a workflow's containers", () => {
    const found = mainFlow(
      flow(
        [canvasStart, ...workspaceNodes, ...sessionBeside, canvasStop],
        [
          intoContainer("canvas-start", "workspace-1"),
          outOfContainer("workspace-1", "canvas-stop"),
          workspaceWire,
          sessionBesideWire,
        ],
        flowSettings,
        {
          containers: [
            workspaceContainer(["ws-start", "ws-stop"]),
            sessionContainer(["s-start", "s-stop"]),
          ],
        },
      ),
    );

    expect(reachedIds(found)).toEqual([
      "canvas-start",
      "canvas-stop",
      "s-start",
      "s-stop",
      "ws-start",
      "ws-stop",
    ]);
    expect(containerIds(found)).toEqual(["session-1", "workspace-1"]);
  });

  it("reaches a workflow's canvas-level session library node unwired, like a session container", () => {
    const found = mainFlow(
      workflowWithLoose(looseLibrary("use", "sessions")),
      libraryOf({ sessions: "session-library" }),
    );

    expect(found?.reached.has("use")).toBe(true);
    expect(found?.ignored).toEqual([]);
  });

  it.each([
    ["a node library", libraryOf({ sessions: "node-library" })],
    ["an incomplete blueprint", libraryOf({ sessions: "incomplete" })],
    ["a workflow", libraryOf({ sessions: "workflow" })],
    ["a blueprint the lookup does not know", libraryOf({})],
    ["any library with no lookup", undefined],
  ])(
    "leaves a workflow's unwired canvas-level library node off the main flow when it is %s",
    (_, lookup) => {
      const found = mainFlow(workflowWithLoose(looseLibrary("use", "sessions")), lookup);

      expect(found?.reached.has("use")).toBe(false);
      expect(found?.ignored.map((node) => node.id)).toEqual(["use"]);
    },
  );
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

  it("keeps a container wire only when the container is reached", () => {
    const sessionTwo = [trigger("t-start"), output("t-stop")];
    const input = flow(
      [canvasStart, trigger("s-start"), output("s-stop"), ...sessionTwo, canvasStop],
      [
        ...throughSession,
        thenWire("s-start", "s-stop"),
        thenWire("t-start", "t-stop"),
        outOfContainer("session-2", "canvas-stop"),
      ],
      flowSettings,
      {
        containers: [
          sessionContainer(["s-start", "s-stop"]),
          sessionContainer(["t-start", "t-stop"], { id: "session-2", name: "other" }),
        ],
      },
    );

    const only = mainFlowOnly(input);

    expect(only.wires).toEqual([...throughSession, thenWire("s-start", "s-stop")]);
  });

  it("drops ignored nodes and every wire with an ignored end", () => {
    const input = oneSession(
      [trigger("start"), agent("a"), agent("b"), agent("c"), output("stop")],
      [thenWire("start", "a"), thenWire("a", "stop"), thenWire("b", "stop"), thenWire("b", "c")],
    );

    const only = mainFlowOnly(input);

    expect(only.nodes.map((node) => node.id)).toEqual([
      "canvas-start",
      "start",
      "a",
      "stop",
      "canvas-stop",
    ]);
    expect(only.wires).toEqual([...throughSession, thenWire("start", "a"), thenWire("a", "stop")]);
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

  it("keeps a loose session library and drops a loose node library in a workflow", () => {
    const input = workflowWithLoose(
      looseLibrary("sessions-use", "sessions"),
      looseLibrary("nodes-use", "nodes"),
    );

    const only = mainFlowOnly(
      input,
      libraryOf({ sessions: "session-library", nodes: "node-library" }),
    );

    expect(only.nodes.filter((node) => node.type === "library").map((node) => node.id)).toEqual([
      "sessions-use",
    ]);
  });

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
