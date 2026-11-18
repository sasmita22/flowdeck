import { describe, expect, it } from "vitest";
import { rule } from "../../../../src/core/compiler/rules/one-start.js";
import {
  agent,
  flow,
  flowSettings,
  output,
  sessionContainer,
  thenWire,
  trigger,
  workspaceContainer,
} from "../../../fixtures/flow-builders.js";

const errorsOf = (input: ReturnType<typeof flow>) =>
  rule.check(input).map(({ rule, container }) => ({ rule, container }));

describe("one-start", () => {
  it("refuses a session container with no Start, naming it", () => {
    expect(errorsOf(flow([agent("a"), output("stop")], [thenWire("a", "stop")]))).toEqual([
      { rule: "one-start", container: "session-1" },
    ]);
  });

  it("refuses a session container with two Starts, naming it", () => {
    const twoStarts = flow(
      [trigger("start"), trigger("again"), agent("a"), output("stop")],
      [thenWire("start", "a"), thenWire("a", "stop")],
    );

    expect(errorsOf(twoStarts)).toEqual([{ rule: "one-start", container: "session-1" }]);
  });

  it("refuses a workspace with no Start, naming it", () => {
    const noWorkspaceStart = flow(
      [output("workspace-stop"), trigger("start"), agent("a"), output("stop")],
      [thenWire("start", "a"), thenWire("a", "stop")],
      flowSettings,
      {
        containers: [
          workspaceContainer(["workspace-stop"]),
          sessionContainer(["start", "a", "stop"]),
        ],
      },
    );

    expect(errorsOf(noWorkspaceStart)).toEqual([{ rule: "one-start", container: "workspace-1" }]);
  });

  it.each([
    ["wired", [thenWire("start", "a"), thenWire("a", "stop")]],
    ["loose", []],
  ])("accepts a workspace and a session with one Start each, %s", (_, wires) => {
    expect(rule.check(flow([trigger("start"), agent("a"), output("stop")], wires))).toEqual([]);
  });
});
