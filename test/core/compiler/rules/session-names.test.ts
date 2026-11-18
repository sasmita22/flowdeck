import { describe, expect, it } from "vitest";
import { rule } from "../../../../src/core/compiler/rules/session-names.js";
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

const sessionNodes = (id: string) => [
  trigger(`${id}-start`),
  agent(`${id}-a`),
  output(`${id}-stop`),
];
const sessionWires = (id: string) => [
  thenWire(`${id}-start`, `${id}-a`),
  thenWire(`${id}-a`, `${id}-stop`),
];

const withSessions = (names: string[]) => {
  const ids = names.map((_, index) => `session-${index + 1}`);
  return flow(
    [trigger("workspace-start"), output("workspace-stop"), ...ids.flatMap(sessionNodes)],
    [thenWire("workspace-start", "workspace-stop"), ...ids.flatMap(sessionWires)],
    flowSettings,
    {
      containers: [
        workspaceContainer(["workspace-start", "workspace-stop"]),
        ...names.map((name, index) => {
          const id = `session-${index + 1}`;
          return sessionContainer([`${id}-start`, `${id}-a`, `${id}-stop`], { id, name });
        }),
      ],
    },
  );
};

const errorsOf = (input: ReturnType<typeof flow>) =>
  rule.check(input).map(({ rule, container, field }) => ({ rule, container, field }));

describe("session-names", () => {
  it("refuses a second session with the same name, naming the second", () => {
    expect(errorsOf(withSessions(["session", "session"]))).toEqual([
      { rule: "session-names", container: "session-2", field: "name" },
    ]);
  });

  it("refuses a session with no name, on its name field", () => {
    expect(errorsOf(withSessions([""]))).toEqual([
      { rule: "session-names", container: "session-1", field: "name" },
    ]);
  });

  it("accepts sessions with distinct names", () => {
    expect(rule.check(withSessions(["session", "session-2"]))).toEqual([]);
  });
});
