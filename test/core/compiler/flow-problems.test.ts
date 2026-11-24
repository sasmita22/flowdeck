import { describe, expect, it } from "vitest";
import { flowProblems } from "../../../src/core/compiler/flow-problems.js";
import type { Flow } from "../../../src/core/flow/schema.js";
import {
  agent,
  flow,
  flowSettings,
  output,
  sessionContainer,
  sessionsWorkflow,
  thenWire,
  trigger,
  wire,
  workspaceContainer,
} from "../../fixtures/flow-builders.js";

const blankAgent = agent("blank", { settings: { instructions: "" } });
const ruleAndNode = (problems: ReturnType<typeof flowProblems>) =>
  problems.map(({ rule, node }) => ({ rule, node }));

describe("flowProblems", () => {
  it("raises nothing for a blank Agent off the main flow", () => {
    const loose = flow(
      [trigger("start"), agent("a"), output("stop"), blankAgent],
      [thenWire("start", "a"), thenWire("a", "stop")],
    );

    expect(flowProblems(loose)).toEqual([]);
  });

  it("raises the blank Agent's settings once it is on the main flow", () => {
    const wired = flow(
      [trigger("start"), agent("a"), output("stop"), blankAgent],
      [thenWire("start", "a"), thenWire("a", "blank"), thenWire("blank", "stop")],
    );

    expect(ruleAndNode(flowProblems(wired))).toEqual([
      { rule: "required-settings", node: "blank" },
    ]);
  });

  it("raises every problem in the flow when it has no Start", () => {
    const noStart = flow(
      [agent("a"), output("stop"), blankAgent],
      [thenWire("a", "stop")],
      flowSettings,
      {
        containers: [sessionContainer(["a", "stop", "blank"])],
      },
    );

    expect(ruleAndNode(flowProblems(noStart))).toEqual(
      expect.arrayContaining([
        { rule: "one-start", node: undefined },
        { rule: "required-settings", node: "blank" },
      ]),
    );
  });

  it("raises one-start when a second Start is loose", () => {
    const twoStarts = flow(
      [trigger("start"), trigger("other"), agent("a"), output("stop")],
      [thenWire("start", "a"), thenWire("a", "stop")],
    );

    expect(flowProblems(twoStarts).map(({ rule }) => rule)).toContain("one-start");
  });

  it("raises stop-required when the only Stop is loose", () => {
    const looseStop = flow(
      [trigger("start"), agent("a"), output("stop")],
      [thenWire("start", "a")],
    );

    expect(flowProblems(looseStop).map(({ rule }) => rule)).toContain("stop-required");
  });

  describe("a workspace and a session, each Start wired to its Stop", () => {
    const seeded = (sessionNodes: string[]) =>
      flow(
        [
          trigger("workspace-start"),
          output("workspace-stop"),
          trigger("start"),
          agent("a"),
          ...(sessionNodes.includes("stop") ? [output("stop")] : []),
        ],
        [
          thenWire("workspace-start", "workspace-stop"),
          thenWire("start", "a"),
          ...(sessionNodes.includes("stop") ? [thenWire("a", "stop")] : []),
        ],
        flowSettings,
        {
          containers: [
            workspaceContainer(["workspace-start", "workspace-stop"]),
            sessionContainer(sessionNodes),
          ],
        },
      );

    it("raises nothing with every setting set", () => {
      expect(flowProblems(seeded(["start", "a", "stop"]))).toEqual([]);
    });

    it("raises stop-required naming the session once its Stop is removed", () => {
      expect(
        flowProblems(seeded(["start", "a"])).map(({ rule, container }) => ({ rule, container })),
      ).toEqual([{ rule: "stop-required", container: "session-1" }]);
    });
  });

  it("numbers a problem's wire by its place in the whole flow, loose wires included", () => {
    const looseWireFirst = flow(
      [trigger("start"), agent("a"), output("stop"), agent("x"), agent("y")],
      [
        thenWire("x", "y"),
        thenWire("start", "a"),
        wire("a", "out", "stop", "bogus"),
        thenWire("a", "stop"),
      ],
    );

    expect(flowProblems(looseWireFirst)).toEqual([
      expect.objectContaining({ rule: "ports", node: "stop", wire: 2 }),
    ]);
  });
});

describe("flowProblems on connections", () => {
  const connected = (...pairs: [string, string][]): Flow => ({
    ...sessionsWorkflow([
      { name: "android", repo: "/repos/android", branch: "main" },
      { name: "ios", repo: "/repos/ios", branch: "main" },
    ]),
    connections: pairs.map((between, index) => ({ id: `c${index + 1}`, between })),
  });
  const connectionProblems = (flow: Flow) =>
    flowProblems(flow).filter(({ rule }) => rule === "session-connections");

  it("raises nothing for two sessions connected once", () => {
    expect(flowProblems(connected(["session-1", "session-2"]))).toEqual([]);
  });

  it.each<[string, [string, string][]]>([
    ["a session to the workspace", [["session-1", "workspace-1"]]],
    ["the workspace to a session", [["workspace-1", "session-1"]]],
    ["a session to a node", [["session-1", "session-2-start"]]],
    ["a session to an unknown id", [["session-1", "missing"]]],
    ["a session to itself", [["session-1", "session-1"]]],
    [
      "a second connection between the same pair",
      [
        ["session-1", "session-2"],
        ["session-1", "session-2"],
      ],
    ],
    [
      "the reversed connection after the first",
      [
        ["session-1", "session-2"],
        ["session-2", "session-1"],
      ],
    ],
  ])("raises session-connections for %s", (_label, pairs) => {
    expect(connectionProblems(connected(...pairs))).toHaveLength(1);
  });
});
