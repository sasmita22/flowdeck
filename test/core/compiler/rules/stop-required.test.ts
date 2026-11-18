import { describe, expect, it } from "vitest";
import { rule } from "../../../../src/core/compiler/rules/stop-required.js";
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

describe("stop-required", () => {
  it("refuses a session container with no Stop, naming it, though the workspace has one", () => {
    expect(errorsOf(flow([trigger("start"), agent("a")], [thenWire("start", "a")]))).toEqual([
      { rule: "stop-required", container: "session-1" },
    ]);
  });

  it("refuses a workspace with no Stop, naming it, though the session has one", () => {
    const noWorkspaceStop = flow(
      [trigger("workspace-start"), trigger("start"), agent("a"), output("stop")],
      [thenWire("start", "a"), thenWire("a", "stop")],
      flowSettings,
      {
        containers: [
          workspaceContainer(["workspace-start"]),
          sessionContainer(["start", "a", "stop"]),
        ],
      },
    );

    expect(errorsOf(noWorkspaceStop)).toEqual([
      { rule: "stop-required", container: "workspace-1" },
    ]);
  });

  it("accepts a workspace and a session whose Starts each reach a Stop", () => {
    const wired = flow(
      [trigger("start"), agent("a"), output("stop")],
      [thenWire("start", "a"), thenWire("a", "stop")],
    );

    expect(rule.check(wired)).toEqual([]);
  });
});
