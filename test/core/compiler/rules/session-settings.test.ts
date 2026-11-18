import { describe, expect, it } from "vitest";
import { rule } from "../../../../src/core/compiler/rules/session-settings.js";
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

const nodes = () => [trigger("start"), agent("a"), output("stop")];
const wires = () => [thenWire("start", "a"), thenWire("a", "stop")];

const withSession = (session: { repo?: string; branch?: string; model?: string }) =>
  flow(nodes(), wires(), flowSettings, { session });

const errorsOf = (input: ReturnType<typeof flow>) =>
  rule.check(input).map(({ rule, container, field }) => ({ rule, container, field }));

describe("session-settings", () => {
  it.each(["repo", "branch", "model"])(
    "refuses a session container with no %s, on that field",
    (field) => {
      expect(errorsOf(withSession({ [field]: "" }))).toEqual([
        { rule: "session-settings", container: "session-1", field },
      ]);
    },
  );

  it("reports each missing setting of a session container on its own field", () => {
    expect(errorsOf(withSession({ repo: "", branch: "", model: "" }))).toEqual([
      { rule: "session-settings", container: "session-1", field: "repo" },
      { rule: "session-settings", container: "session-1", field: "branch" },
      { rule: "session-settings", container: "session-1", field: "model" },
    ]);
  });

  it("refuses a workspace with no model, on its model field", () => {
    const noWorkspaceModel = flow(
      [trigger("workspace-start"), output("workspace-stop"), ...nodes()],
      [thenWire("workspace-start", "workspace-stop"), ...wires()],
      flowSettings,
      {
        containers: [
          workspaceContainer(["workspace-start", "workspace-stop"], { model: "" }),
          sessionContainer(["start", "a", "stop"]),
        ],
      },
    );

    expect(errorsOf(noWorkspaceModel)).toEqual([
      { rule: "session-settings", container: "workspace-1", field: "model" },
    ]);
  });

  it("accepts containers with every setting set", () => {
    expect(rule.check(withSession({ repo: "/work/repo", branch: "main", model: "opus" }))).toEqual(
      [],
    );
  });
});
