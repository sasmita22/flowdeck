import { describe, expect, it } from "vitest";
import { rule } from "../../../../src/core/compiler/rules/workspace-count.js";
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

const workspaceNodes = (id: string) => [trigger(`${id}-start`), output(`${id}-stop`)];
const workspaceWire = (id: string) => thenWire(`${id}-start`, `${id}-stop`);

const withWorkspaces = (ids: string[]) =>
  flow(
    [...ids.flatMap(workspaceNodes), trigger("start"), agent("a"), output("stop")],
    [...ids.map(workspaceWire), thenWire("start", "a"), thenWire("a", "stop")],
    flowSettings,
    {
      containers: [
        ...ids.map((id) => workspaceContainer([`${id}-start`, `${id}-stop`], { id })),
        sessionContainer(["start", "a", "stop"]),
      ],
    },
  );

const errorsOf = (input: ReturnType<typeof withWorkspaces>) =>
  rule.check(input).map(({ rule, container }) => ({ rule, container }));

describe("workspace-count", () => {
  it("refuses a second workspace, naming it", () => {
    expect(errorsOf(withWorkspaces(["workspace-1", "workspace-2"]))).toEqual([
      { rule: "workspace-count", container: "workspace-2" },
    ]);
  });

  it("accepts one workspace", () => {
    expect(rule.check(withWorkspaces(["workspace-1"]))).toEqual([]);
  });
});
