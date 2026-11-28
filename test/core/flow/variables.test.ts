import { describe, expect, it } from "vitest";
import {
  libraryLookup,
  unknownLibraries,
  type LibraryLookup,
} from "../../../src/core/flow/libraries.js";
import {
  blueprintVariables,
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
  fork,
  join,
  onMainFlow,
  output,
  thenWire,
  trigger,
  sessionContainer,
  wire,
  workspaceContainer,
} from "../../fixtures/flow-builders.js";
import { parseFlow, type Flow } from "../../../src/core/flow/schema.js";

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

const producing = (id: string, ...names: string[]) =>
  agent(id, {
    settings: {
      produces: names.map((variable) => ({ variable, yesIf: "it holds", noIf: "it does not" })),
    },
  });

const analysed = (flow: Flow) => blueprintVariables(flow, unknownLibraries);

const ownedOf = (flow: Flow) => analysed(flow).owned;

describe("blueprintVariables", () => {
  it("lists each Branch variable once, even when two Branches share it", () => {
    const flow = onMainFlow(
      [branch("first", "approved"), branch("second", "approved"), branch("third", "docs")],
      [wire("first", "yes", "second", "in"), wire("second", "yes", "third", "in")],
    );

    expect(ownedOf(flow).map(({ name }) => name)).toEqual(["approved", "docs"]);
  });

  it("calls a variable defined by the Agent wired before its Branch, naming that Agent", () => {
    const reviewer = { ...producing("review", "approved"), label: "Reviewer" };
    const flow = onMainFlow(
      [reviewer, branch("decide", "approved")],
      [thenWire("review", "decide")],
    );

    expect(ownedOf(flow)).toEqual([{ name: "approved", definedBy: ["Reviewer"] }]);
  });

  it("names only the producers that run before the Branch", () => {
    const flow = onMainFlow(
      [
        producing("review", "approved"),
        branch("decide", "approved"),
        producing("recheck", "approved"),
      ],
      [thenWire("review", "decide"), wire("decide", "yes", "recheck", "in")],
    );

    expect(ownedOf(flow)).toEqual([{ name: "approved", definedBy: ["review"] }]);
  });

  it("calls a variable not defined when its only producer runs after the Branch", () => {
    const flow = onMainFlow(
      [branch("decide", "approved"), producing("review", "approved")],
      [wire("decide", "yes", "review", "in")],
    );

    expect(ownedOf(flow)).toEqual([{ name: "approved" }]);
  });

  it.each<[string, () => Flow]>([
    [
      "an earlier Branch",
      () =>
        onMainFlow(
          [branch("first", "ready"), producing("review", "approved"), branch("decide", "approved")],
          [
            wire("first", "yes", "review", "in"),
            thenWire("review", "decide"),
            wire("first", "no", "decide", "in"),
          ],
        ),
    ],
    [
      "a Fork",
      () =>
        onMainFlow(
          [
            fork("split"),
            producing("review", "approved"),
            agent("lint"),
            join("meet"),
            branch("decide", "approved"),
          ],
          [
            thenWire("split", "review"),
            thenWire("split", "lint"),
            thenWire("review", "meet"),
            thenWire("lint", "meet"),
            thenWire("meet", "decide"),
          ],
        ),
    ],
  ])("calls a variable not defined when its producer is on only one side of %s", (_, built) => {
    expect(ownedOf(built()).find(({ name }) => name === "approved")).toEqual({ name: "approved" });
  });

  it("calls the variable not defined once its produce row is removed", () => {
    const flow = onMainFlow(
      [agent("review"), branch("decide", "approved")],
      [thenWire("review", "decide")],
    );

    expect(ownedOf(flow)).toEqual([{ name: "approved" }]);
  });

  it("calls the variable not defined once the wire from its producer to the Branch is removed", () => {
    const flow = onMainFlow([producing("review", "approved"), branch("decide", "approved")], []);

    expect(ownedOf(flow)).toEqual([{ name: "approved" }]);
  });

  it("calls a shared variable not defined when its producer runs before only one of its Branches", () => {
    const flow = onMainFlow(
      [branch("first", "approved"), producing("review", "approved"), branch("second", "approved")],
      [wire("first", "yes", "review", "in"), thenWire("review", "second")],
    );

    expect(ownedOf(flow)).toEqual([{ name: "approved" }]);
  });

  it("counts the Start inside the Branch's container as where its paths begin", () => {
    const inside = flow(
      [
        trigger("canvas-start"),
        trigger("ws-start"),
        producing("review", "approved"),
        branch("decide", "approved"),
        output("ws-stop"),
        output("canvas-stop"),
      ],
      [
        wire("canvas-start", "out", "workspace-1", "flow-in"),
        thenWire("ws-start", "review"),
        thenWire("review", "decide"),
        wire("decide", "yes", "ws-stop", "in"),
        wire("decide", "no", "ws-stop", "in"),
        wire("workspace-1", "flow-out", "canvas-stop", "in"),
      ],
      flowSettings,
      { containers: [workspaceContainer(["ws-start", "review", "decide", "ws-stop"])] },
    );

    expect(ownedOf(inside)).toEqual([{ name: "approved", definedBy: ["review"] }]);
  });

  it("does not count a producer in an earlier container as running before the Branch", () => {
    const apart = flow(
      [
        trigger("canvas-start"),
        trigger("ws-start"),
        producing("review", "approved"),
        output("ws-stop"),
        trigger("s1-start"),
        branch("decide", "approved"),
        output("s1-stop"),
        output("canvas-stop"),
      ],
      [
        wire("canvas-start", "out", "workspace-1", "flow-in"),
        thenWire("ws-start", "review"),
        thenWire("review", "ws-stop"),
        wire("workspace-1", "flow-out", "session-1", "flow-in"),
        thenWire("s1-start", "decide"),
        wire("decide", "yes", "s1-stop", "in"),
        wire("decide", "no", "s1-stop", "in"),
        wire("session-1", "flow-out", "canvas-stop", "in"),
      ],
      flowSettings,
      {
        containers: [
          workspaceContainer(["ws-start", "review", "ws-stop"]),
          sessionContainer(["s1-start", "decide", "s1-stop"]),
        ],
      },
    );

    expect(ownedOf(apart)).toEqual([{ name: "approved" }]);
  });

  it("sends up exactly the variables it does not define", () => {
    const flow = onMainFlow(
      [producing("review", "approved"), branch("decide", "approved"), branch("docs", "docs")],
      [thenWire("review", "decide"), wire("decide", "yes", "docs", "in")],
    );

    expect(analysed(flow).sends).toEqual(["docs"]);
  });

  it("asks for the variables it does not define and every text variable, never a defined one", () => {
    const flow = onMainFlow(
      [
        agent("review", {
          settings: {
            instructions: "Review {{ticket}}.",
            produces: [{ variable: "approved", yesIf: "ok", noIf: "not ok" }],
          },
        }),
        branch("decide", "approved"),
        branch("docs", "docs"),
      ],
      [thenWire("review", "decide"), wire("decide", "yes", "docs", "in")],
    );

    expect(analysed(flow).toAsk).toEqual([
      { name: "docs", kind: "yes-no", nodeIds: ["docs"] },
      { name: "ticket", kind: "text", nodeIds: ["review"] },
    ]);
  });
});

const usesLibrary = (id: string, libraryId: string) => ({
  id,
  label: id,
  position: { x: 0, y: 0 },
  type: "library",
  settings: { libraryId, label: id, overrides: {} },
});

const sending =
  (sends: Record<string, string[]>): LibraryLookup =>
  (flowId) =>
    sends[flowId] === undefined
      ? undefined
      : { name: flowId, kind: "node-library", sessions: [], uses: [], sends: sends[flowId] };

const plainLibrary = (members: { id: string }[], wires: unknown[]): Flow =>
  parseFlow({
    nodes: [trigger("canvas-start"), ...members, output("canvas-stop")],
    wires,
    containers: [],
    settings: flowSettings,
  });

describe("blueprintVariables with libraries", () => {
  const lookup = sending({ asks: ["up"], keeps: [] });

  it("owns its own Branch variables and what its libraries send up, never a library's own", () => {
    const host = onMainFlow(
      [branch("decide", "own"), usesLibrary("ask", "asks"), usesLibrary("keep", "keeps")],
      [wire("decide", "yes", "ask", "in"), thenWire("ask", "keep")],
    );

    const { owned, sends } = blueprintVariables(host, lookup);

    expect(owned.map(({ name }) => name)).toEqual(["own", "up"]);
    expect(sends).toEqual(["own", "up"]);
  });

  it("calls a sent-up variable defined by an Agent before the Library node", () => {
    const host = onMainFlow(
      [producing("review", "up"), usesLibrary("ask", "asks")],
      [thenWire("review", "ask")],
    );

    const { owned, sends } = blueprintVariables(host, lookup);

    expect(owned).toEqual([{ name: "up", definedBy: ["review"] }]);
    expect(sends).toEqual([]);
  });

  it("sends a library's variable up again when nothing before the Library node defines it", () => {
    const host = onMainFlow([agent("plan"), usesLibrary("ask", "asks")], [thenWire("plan", "ask")]);

    const { owned, sends, toAsk } = blueprintVariables(host, lookup);

    expect(owned).toEqual([{ name: "up" }]);
    expect(sends).toEqual(["up"]);
    expect(toAsk).toEqual([{ name: "up", kind: "yes-no", nodeIds: ["ask"] }]);
  });

  it("sends a variable up through every level nobody defines it on, and keeps one a level defines", () => {
    const libraries: Record<string, Flow> = {
      leaf: plainLibrary(
        [branch("decide", "approved"), producing("check", "inner"), branch("judge", "inner")],
        [
          thenWire("canvas-start", "decide"),
          wire("decide", "yes", "check", "in"),
          wire("decide", "no", "check", "in"),
          thenWire("check", "judge"),
          wire("judge", "yes", "canvas-stop", "in"),
          wire("judge", "no", "canvas-stop", "in"),
        ],
      ),
      middle: plainLibrary(
        [agent("plan"), usesLibrary("use-leaf", "leaf")],
        [
          thenWire("canvas-start", "plan"),
          thenWire("plan", "use-leaf"),
          thenWire("use-leaf", "canvas-stop"),
        ],
      ),
    };
    const resolve = (flowId: string) => {
      const flow = libraries[flowId];
      return flow === undefined ? undefined : { name: flowId, flow };
    };
    const host = onMainFlow([usesLibrary("use-middle", "middle")], []);

    const { owned, sends } = blueprintVariables(host, libraryLookup(resolve));

    expect(owned).toEqual([{ name: "approved" }]);
    expect(sends).toEqual(["approved"]);
  });
});
