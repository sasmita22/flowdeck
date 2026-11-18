import { describe, expect, it } from "vitest";
import {
  flowContainerMembers,
  flowContainerOf,
  flowKind,
  isWorkflow,
  sessionBuildConfig,
} from "../../../src/core/flow/structure.js";
import {
  agent,
  flow,
  flowSettings,
  loop,
  output,
  sessionContainer,
  trigger,
  workspaceContainer,
} from "../../fixtures/flow-builders.js";

const workflow = flow(
  [
    trigger("ws-start"),
    output("ws-stop"),
    trigger("start"),
    agent("a"),
    loop("l"),
    agent("x", { parent: "l" }),
    agent("y", { parent: "l" }),
    output("stop"),
    agent("loose"),
  ],
  [],
  flowSettings,
  {
    containers: [
      workspaceContainer(["ws-start", "ws-stop"]),
      sessionContainer(["start", "a", "l", "stop"]),
    ],
  },
);

const libraryOf = (containers: unknown[]) =>
  flow([agent("a"), agent("b")], [], flowSettings, { containers });

describe("flowContainerOf", () => {
  it("finds the container that lists the node", () => {
    expect(flowContainerOf(workflow, "a")?.id).toBe("session-1");
    expect(flowContainerOf(workflow, "ws-stop")?.id).toBe("workspace-1");
  });

  it("finds a body node's container through its loop", () => {
    expect(flowContainerOf(workflow, "x")?.id).toBe("session-1");
  });

  it("is undefined for a node no container lists", () => {
    expect(flowContainerOf(workflow, "loose")).toBeUndefined();
  });
});

describe("flowContainerMembers", () => {
  it("lists a container's direct members and their body nodes", () => {
    expect([...flowContainerMembers(workflow, "session-1")].sort()).toEqual([
      "a",
      "l",
      "start",
      "stop",
      "x",
      "y",
    ]);
  });

  it("lists only a container's own members", () => {
    expect([...flowContainerMembers(workflow, "workspace-1")].sort()).toEqual([
      "ws-start",
      "ws-stop",
    ]);
  });
});

describe("flowKind", () => {
  it("is a workflow with a workspace", () => {
    expect(flowKind(workflow)).toBe("workflow");
    expect(isWorkflow(workflow)).toBe(true);
  });

  it.each([
    ["only session containers", [sessionContainer(["a"]), sessionContainer(["b"], { id: "s2" })]],
    ["no containers", []],
  ])("is a library with %s", (_, containers) => {
    const library = libraryOf(containers);

    expect(flowKind(library)).toBe("library");
    expect(isWorkflow(library)).toBe(false);
  });
});

describe("sessionBuildConfig", () => {
  it("reads the first session's repo and branch as the build's repo and base", () => {
    expect(sessionBuildConfig(workflow)).toEqual({ repo: "/work/repo", base: "main" });
  });

  it("leaves out an empty repo or branch", () => {
    expect(
      sessionBuildConfig(libraryOf([sessionContainer(["a"], { repo: "", branch: "" })])),
    ).toEqual({});
  });

  it("is undefined with no session", () => {
    expect(sessionBuildConfig(libraryOf([]))).toBeUndefined();
  });
});
