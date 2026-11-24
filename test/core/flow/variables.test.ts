import { describe, expect, it } from "vitest";
import {
  fillVariables,
  foundVariables,
  groupVariables,
  isVariableName,
  referencedVariables,
} from "../../../src/core/flow/variables.js";
import {
  agent,
  branch,
  flow,
  flowSettings,
  onMainFlow,
  output,
  thenWire,
  trigger,
  sessionContainer,
  workspaceContainer,
} from "../../fixtures/flow-builders.js";

const instructed = (id: string, instructions: string) => agent(id, { settings: { instructions } });

describe("referencedVariables", () => {
  it("returns each distinct name once, in the order first used", () => {
    expect(referencedVariables("Fix {{ticket}} and {{ticket}} {{ x }}")).toEqual(["ticket", "x"]);
  });

  it("returns a dotted library name whole", () => {
    expect(referencedVariables("Fix {{android-app.ticket}} and {{ a.b.c }}")).toEqual([
      "android-app.ticket",
      "a.b.c",
    ]);
  });

  it("returns nothing for text without a variable", () => {
    expect(referencedVariables("Implement the plan.")).toEqual([]);
  });
});

describe("foundVariables", () => {
  it("finds a yes/no variable from a Branch and a text variable from an Agent, and nothing else", () => {
    const found = foundVariables(
      onMainFlow(
        [branch("decide", "ship"), instructed("plan", "Plan {{ticket}}."), agent("build")],
        [thenWire("decide", "plan"), thenWire("plan", "build")],
      ),
    );

    expect(found).toEqual([
      { name: "ship", kind: "yes-no", nodeIds: ["decide"] },
      { name: "ticket", kind: "text", nodeIds: ["plan"] },
    ]);
  });

  it("lists a name two Agents use once, with both nodes", () => {
    const found = foundVariables(
      onMainFlow(
        [instructed("plan", "Plan {{ticket}}."), instructed("build", "Build {{ ticket }}.")],
        [thenWire("plan", "build")],
      ),
    );

    expect(found).toHaveLength(1);
    expect(found[0]?.name).toBe("ticket");
    expect(found[0]?.kind).toBe("text");
    expect([...(found[0]?.nodeIds ?? [])].sort()).toEqual(["build", "plan"]);
  });

  it("finds no variable in a Branch decided by a value", () => {
    const byValue = {
      ...branch("decide", "ship"),
      settings: { variable: "ship", decidedBy: "value", value: "tests-passed" },
    };

    expect(foundVariables(onMainFlow([byValue], []))).toEqual([]);
  });

  it("ignores nodes off the main flow", () => {
    const found = foundVariables(
      flow(
        [
          trigger("start"),
          instructed("plan", "Plan {{ticket}}."),
          output("stop"),
          instructed("stray", "Use {{ghost}}."),
          branch("loose", "lost"),
        ],
        [thenWire("start", "plan"), thenWire("plan", "stop")],
      ),
    );

    expect(found.map(({ name }) => name)).toEqual(["ticket"]);
  });

  it("finds the variables of every container's main flow, and none off them", () => {
    const found = foundVariables(
      flow(
        [
          trigger("ws-start"),
          output("ws-stop"),
          trigger("s1-start"),
          branch("decide", "ship"),
          output("s1-stop"),
          trigger("s2-start"),
          instructed("plan", "Plan {{ticket}}."),
          output("s2-stop"),
          instructed("stray", "Use {{ghost}}."),
        ],
        [
          thenWire("ws-start", "ws-stop"),
          thenWire("s1-start", "decide"),
          thenWire("decide", "s1-stop"),
          thenWire("s2-start", "plan"),
          thenWire("plan", "s2-stop"),
        ],
        flowSettings,
        {
          containers: [
            workspaceContainer(["ws-start", "ws-stop"]),
            sessionContainer(["s1-start", "decide", "s1-stop"]),
            sessionContainer(["s2-start", "plan", "s2-stop", "stray"], {
              id: "session-2",
              name: "review",
            }),
          ],
        },
      ),
    );

    expect(found).toEqual([
      { name: "ship", kind: "yes-no", nodeIds: ["decide"] },
      { name: "ticket", kind: "text", nodeIds: ["plan"] },
    ]);
  });

  it("finds nothing in a flow with no Branch and no {{name}}", () => {
    expect(foundVariables(onMainFlow([agent("build")], []))).toEqual([]);
  });

  it("gives a name used as both yes/no and text one entry per kind, each with its node", () => {
    const found = foundVariables(
      onMainFlow(
        [branch("decide", "x"), instructed("plan", "Plan {{x}}.")],
        [thenWire("decide", "plan")],
      ),
    );

    expect(found).toHaveLength(2);
    expect(found).toEqual(
      expect.arrayContaining([
        { name: "x", kind: "yes-no", nodeIds: ["decide"] },
        { name: "x", kind: "text", nodeIds: ["plan"] },
      ]),
    );
  });
});

describe("fillVariables", () => {
  it("puts a text value in place of its name", () => {
    expect(fillVariables("Fix {{ticket}}", { ticket: "FD-99" })).toBe("Fix FD-99");
  });

  it("fills a name written with spaces inside the braces", () => {
    expect(fillVariables("Fix {{ ticket }}", { ticket: "FD-99" })).toBe("Fix FD-99");
  });

  it("fills a dotted library name with its own value, not the host's", () => {
    expect(
      fillVariables("{{ticket}} / {{android-app.ticket}}", {
        ticket: "FD-1",
        "android-app.ticket": "FD-2",
      }),
    ).toBe("FD-1 / FD-2");
  });

  it.each([
    [true, "Run e2e: true"],
    [false, "Run e2e: false"],
  ])("fills the yes/no value %j as %j", (value, filled) => {
    expect(fillVariables("Run e2e: {{e2e}}", { e2e: value })).toBe(filled);
  });
});

describe("isVariableName", () => {
  it.each(["proceed-e2e", "ticket", "step_2", "A1", "a.b", "android-app.e2e-tests.isFullScan"])(
    "accepts %j",
    (name) => {
      expect(isVariableName(name)).toBe(true);
    },
  );

  it.each(["-x", "a b", "", "_x", "{{x}}", ".a", "a.", "a..b", "a.-b", "a. b"])(
    "rejects %j",
    (name) => {
      expect(isVariableName(name)).toBe(false);
    },
  );
});

describe("groupVariables", () => {
  const uses = [
    { path: "android-app", name: "Android", kind: "node-library" as const },
    { path: "android-app.e2e-tests", name: "E2E tests", kind: "node-library" as const },
    { path: "android-app-2", name: "Android", kind: "node-library" as const },
  ];
  const text = (name: string) => ({ name, kind: "text" as const, nodeIds: ["n"] as [string] });

  it("puts each variable in the use with the longest matching path", () => {
    expect(
      groupVariables(
        [
          text("android-app.ticket"),
          text("android-app.e2e-tests.isFullScan"),
          text("android-app-2.ticket"),
        ],
        uses,
      ),
    ).toEqual([
      { ...text("android-app.ticket"), group: { path: "android-app", name: "Android" } },
      {
        ...text("android-app.e2e-tests.isFullScan"),
        group: { path: "android-app.e2e-tests", name: "E2E tests" },
      },
      { ...text("android-app-2.ticket"), group: { path: "android-app-2", name: "Android" } },
    ]);
  });

  it("leaves the host's own variables, and a name only sharing a prefix, without a group", () => {
    expect(groupVariables([text("ticket"), text("android-apple.x")], uses)).toEqual([
      text("ticket"),
      text("android-apple.x"),
    ]);
  });
});
