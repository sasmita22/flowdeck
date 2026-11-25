import { describe, expect, it } from "vitest";
import { validate } from "../../src/core/compiler/validate.js";
import { mainFlow } from "../../src/core/flow/main-flow.js";
import {
  agent,
  canvasPath,
  flow,
  flowSettings,
  loop,
  onMainFlow,
  onWorkspaceMainFlow,
  output,
  sessionContainer,
  sessionLibrary,
  sessionsWorkflow,
  thenWire,
  trigger,
  wire,
  workspaceContainer,
  workspaceFlow,
} from "./flow-builders.js";

const reachedIds = (found: ReturnType<typeof mainFlow>) => [...(found?.reached ?? [])].sort();

describe("onMainFlow", () => {
  it("wires Start into the chain and the chain into Stop", () => {
    const result = onMainFlow([agent("a"), agent("b")], [thenWire("a", "b")]);

    expect(result.nodes.find((node) => node.id === "start")?.type).toBe("trigger");
    expect(result.nodes.find((node) => node.id === "stop")?.type).toBe("output");
    expect(result.wires).toEqual(
      expect.arrayContaining([thenWire("start", "a"), thenWire("b", "stop")]),
    );
    expect(mainFlow(result)?.ignored).toEqual([]);
  });

  it("reaches a loose node next to a chain", () => {
    const result = onMainFlow([agent("a"), agent("b"), agent("c")], [thenWire("a", "b")]);

    expect(reachedIds(mainFlow(result))).toEqual([
      "a",
      "b",
      "c",
      "canvas-start",
      "canvas-stop",
      "start",
      "stop",
      "workspace-1-start",
      "workspace-1-stop",
    ]);
  });

  it("reaches a Loop through its body wires without wiring the frame", () => {
    const result = onMainFlow(
      [agent("a"), loop("l"), agent("x", { parent: "l" }), agent("y", { parent: "l" }), agent("b")],
      [thenWire("a", "x"), thenWire("x", "y"), thenWire("y", "b")],
    );

    expect(reachedIds(mainFlow(result))).toEqual([
      "a",
      "b",
      "canvas-start",
      "canvas-stop",
      "l",
      "start",
      "stop",
      "workspace-1-start",
      "workspace-1-stop",
      "x",
      "y",
    ]);
    expect(result.wires.filter((wire) => wire.from.node === "l" || wire.to.node === "l")).toEqual(
      [],
    );
  });

  it.each([
    ["an id start", [agent("start")]],
    ["an id stop", [agent("stop")]],
    ["a trigger", [trigger("go")]],
    ["an output", [output("done")]],
  ])("throws on input holding %s", (_, nodes) => {
    expect(() => onMainFlow(nodes, [])).toThrow();
  });
});

describe("flow", () => {
  const defaultWorkspace = {
    id: "workspace-1",
    kind: "workspace",
    model: "sonnet",
    nodes: ["workspace-1-start", "workspace-1-stop"],
  };

  const defaultSession = {
    id: "session-1",
    kind: "session",
    name: "main",
    repo: "/work/repo",
    branch: "main",
    model: "sonnet",
  };

  it("puts every top-level node in one session container beside a workspace", () => {
    const result = flow([agent("a"), loop("l"), agent("x", { parent: "l" }), agent("b")], []);

    expect(result.containers).toEqual([
      defaultWorkspace,
      { ...defaultSession, nodes: ["a", "l", "b"] },
    ]);
  });

  it("appends the workspace's Start and Stop, the Then wire between them and the canvas path", () => {
    const result = flow([agent("a"), agent("b")], [thenWire("a", "b")]);

    expect(result.nodes.map(({ id, type }) => ({ id, type }))).toEqual([
      { id: "a", type: "agent" },
      { id: "b", type: "agent" },
      { id: "workspace-1-start", type: "trigger" },
      { id: "workspace-1-stop", type: "output" },
      { id: "canvas-start", type: "trigger" },
      { id: "canvas-stop", type: "output" },
    ]);
    expect(result.wires).toEqual([
      thenWire("a", "b"),
      thenWire("workspace-1-start", "workspace-1-stop"),
      wire("canvas-start", "out", "workspace-1", "flow-in"),
      wire("workspace-1", "flow-out", "canvas-stop", "in"),
    ]);
  });

  it("leaves the workspace with no Start, Stop, count or membership problem", () => {
    const containerRules = [
      "workspace-count",
      "one-start",
      "stop-required",
      "one-stop",
      "outside-container",
    ];
    const workspaceIds = new Set(["workspace-1", "workspace-1-start", "workspace-1-stop"]);
    const result = flow([agent("a")], []);

    expect(result.wires).toContainEqual(thenWire("workspace-1-start", "workspace-1-stop"));
    expect(
      validate(result).filter(
        (error) =>
          containerRules.includes(error.rule) &&
          (workspaceIds.has(error.container ?? "") || workspaceIds.has(error.node ?? "")),
      ),
    ).toEqual([]);
  });

  it.each([
    ["name", "review"],
    ["repo", "/r/shop"],
    ["branch", "dev"],
    ["model", "haiku"],
  ])("sets the session container's %s", (field, value) => {
    const result = flow([agent("a")], [], flowSettings, { session: { [field]: value } });

    expect(result.containers[1]).toEqual({ ...defaultSession, nodes: ["a"], [field]: value });
  });

  it("takes a containers list verbatim, adding no workspace nodes", () => {
    const containers = [
      sessionContainer(["a"]),
      sessionContainer(["b"], { id: "session-2", name: "review" }),
    ];

    const result = flow([agent("a"), agent("b")], [], flowSettings, { containers });

    expect(result.containers).toEqual(containers);
    expect(result.nodes.map((node) => node.id)).toEqual(["a", "b"]);
    expect(result.wires).toEqual([]);
  });
});

describe("sessionLibrary", () => {
  it("puts the nodes in session-1 and wires canvas Start into its flow-in and its flow-out into canvas Stop", () => {
    const result = sessionLibrary([agent("a"), agent("b")], [thenWire("a", "b")]);

    expect(result.containers).toEqual([sessionContainer(["a", "b"])]);
    expect(result.nodes.map(({ id, type, parent }) => ({ id, type, parent }))).toEqual([
      { id: "a", type: "agent", parent: undefined },
      { id: "b", type: "agent", parent: undefined },
      { id: "canvas-start", type: "trigger", parent: undefined },
      { id: "canvas-stop", type: "output", parent: undefined },
    ]);
    expect(result.wires).toEqual([
      thenWire("a", "b"),
      wire("canvas-start", "out", "session-1", "flow-in"),
      wire("session-1", "flow-out", "canvas-stop", "in"),
    ]);
  });
});

describe("workspaceFlow", () => {
  const defaultSession = {
    id: "session-1",
    kind: "session",
    name: "main",
    repo: "/work/repo",
    branch: "main",
    model: "sonnet",
    nodes: ["session-1-start", "session-1-stop"],
  };

  it("puts every top-level node in the workspace beside a session container of Start and Stop only", () => {
    const result = workspaceFlow(
      [agent("a"), loop("l"), agent("x", { parent: "l" }), agent("b")],
      [],
    );

    expect(result.containers).toEqual([
      { id: "workspace-1", kind: "workspace", model: "sonnet", nodes: ["a", "l", "b"] },
      defaultSession,
    ]);
  });

  it("appends the session container's Start and Stop, the Then wire between them and the canvas path", () => {
    const result = workspaceFlow([agent("a"), agent("b")], [thenWire("a", "b")]);

    expect(result.nodes.map(({ id, type }) => ({ id, type }))).toEqual([
      { id: "a", type: "agent" },
      { id: "b", type: "agent" },
      { id: "session-1-start", type: "trigger" },
      { id: "session-1-stop", type: "output" },
      { id: "canvas-start", type: "trigger" },
      { id: "canvas-stop", type: "output" },
    ]);
    expect(result.wires).toEqual([
      thenWire("a", "b"),
      thenWire("session-1-start", "session-1-stop"),
      wire("canvas-start", "out", "workspace-1", "flow-in"),
      wire("workspace-1", "flow-out", "canvas-stop", "in"),
    ]);
  });

  it("leaves the session container with no Start, Stop, count or membership problem", () => {
    const containerRules = [
      "workspace-count",
      "one-start",
      "stop-required",
      "one-stop",
      "outside-container",
    ];
    const sessionIds = new Set(["session-1", "session-1-start", "session-1-stop"]);

    expect(
      validate(workspaceFlow([agent("a")], [])).filter(
        (error) =>
          containerRules.includes(error.rule) &&
          (sessionIds.has(error.container ?? "") || sessionIds.has(error.node ?? "")),
      ),
    ).toEqual([]);
  });

  it.each([
    ["name", "review"],
    ["repo", "/r/shop"],
    ["branch", "dev"],
    ["model", "haiku"],
  ])("sets the session container's %s", (field, value) => {
    const result = workspaceFlow([agent("a")], [], flowSettings, { session: { [field]: value } });

    expect(result.containers[1]).toEqual({ ...defaultSession, [field]: value });
  });

  it("takes a containers list verbatim, as flow does", () => {
    const containers = [workspaceContainer(["a"])];

    expect(workspaceFlow([agent("a")], [], flowSettings, { containers })).toEqual(
      flow([agent("a")], [], flowSettings, { containers }),
    );
  });
});

describe("onWorkspaceMainFlow", () => {
  it("wires Start into the chain and the chain into Stop, all in the workspace", () => {
    const result = onWorkspaceMainFlow([agent("a"), agent("b")], [thenWire("a", "b")]);

    expect(result.containers[0]?.nodes).toEqual(["start", "a", "b", "stop"]);
    expect(result.containers[1]?.nodes).toEqual(["session-1-start", "session-1-stop"]);
    expect(result.wires).toEqual(
      expect.arrayContaining([thenWire("start", "a"), thenWire("b", "stop")]),
    );
    expect(mainFlow(result)?.ignored).toEqual([]);
    expect(validate(result)).toEqual([]);
  });

  it("throws on input holding a trigger, as onMainFlow does", () => {
    expect(() => onWorkspaceMainFlow([trigger("go")], [])).toThrow("adds Start and Stop itself");
  });
});

describe("workspaceContainer and sessionContainer", () => {
  it("build containers with the flow builder's defaults", () => {
    expect(workspaceContainer(["s", "t"])).toEqual({
      id: "workspace-1",
      kind: "workspace",
      model: "sonnet",
      nodes: ["s", "t"],
    });
    expect(sessionContainer(["a"])).toEqual({
      id: "session-1",
      kind: "session",
      name: "main",
      repo: "/work/repo",
      branch: "main",
      model: "sonnet",
      nodes: ["a"],
    });
  });

  it("take every field as an option", () => {
    expect(workspaceContainer([], { id: "workspace-2", model: "" })).toEqual({
      id: "workspace-2",
      kind: "workspace",
      model: "",
      nodes: [],
    });
    expect(
      sessionContainer(["a"], {
        id: "session-2",
        name: "review",
        repo: "",
        branch: "dev",
        model: "haiku",
      }),
    ).toEqual({
      id: "session-2",
      kind: "session",
      name: "review",
      repo: "",
      branch: "dev",
      model: "haiku",
      nodes: ["a"],
    });
  });
});

describe("canvas path", () => {
  const throughWorkspace = [
    wire("canvas-start", "out", "workspace-1", "flow-in"),
    wire("workspace-1", "flow-out", "canvas-stop", "in"),
  ];

  it.each([
    ["flow", () => flow([agent("a")], [])],
    ["workspaceFlow", () => workspaceFlow([agent("a")], [])],
    ["onMainFlow", () => onMainFlow([agent("a")], [])],
    ["onWorkspaceMainFlow", () => onWorkspaceMainFlow([agent("a")], [])],
    ["sessionsWorkflow", () => sessionsWorkflow([{ name: "a", repo: "/r/a", branch: "main" }])],
  ])("%s wires a canvas Start through the workspace to a canvas Stop", (_, build) => {
    const result = build();

    expect(result.nodes.slice(-2).map(({ id, type }) => ({ id, type }))).toEqual([
      { id: "canvas-start", type: "trigger" },
      { id: "canvas-stop", type: "output" },
    ]);
    expect(result.wires.slice(-2)).toEqual(throughWorkspace);
    expect(validate(result).filter((error) => error.rule === "workflow-path")).toEqual([]);
  });

  it("canvasPath adds the same path to an inline workflow", () => {
    const inline = flow(
      [trigger("w-start"), output("w-stop")],
      [thenWire("w-start", "w-stop")],
      flowSettings,
      {
        containers: [workspaceContainer(["w-start", "w-stop"])],
      },
    );

    const result = canvasPath(inline);

    expect(result.wires.slice(-2)).toEqual(throughWorkspace);
    expect(validate(result)).toEqual([]);
  });
});
