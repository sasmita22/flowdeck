import { describe, expect, it } from "vitest";
import { validate } from "../../src/core/compiler/validate.js";
import { mainFlow } from "../../src/core/flow/main-flow.js";
import {
  agent,
  flow,
  flowSettings,
  loop,
  onMainFlow,
  output,
  sessionContainer,
  thenWire,
  trigger,
  workspaceContainer,
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

  it("appends the workspace's Start and Stop and the Then wire between them", () => {
    const result = flow([agent("a"), agent("b")], [thenWire("a", "b")]);

    expect(result.nodes.map(({ id, type }) => ({ id, type }))).toEqual([
      { id: "a", type: "agent" },
      { id: "b", type: "agent" },
      { id: "workspace-1-start", type: "trigger" },
      { id: "workspace-1-stop", type: "output" },
    ]);
    expect(result.wires).toEqual([
      thenWire("a", "b"),
      thenWire("workspace-1-start", "workspace-1-stop"),
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
