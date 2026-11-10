import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ManifestNode } from "../../../../src/core/compiler/lower.js";
import {
  branchDecision,
  branchSkips,
  branchTakes,
  triggerFlags,
} from "../../../../src/core/nodes/branch/execute.js";
import { parseFlow } from "../../../../src/core/flow/schema.js";
import {
  agent,
  branch,
  flow,
  forEach,
  fork,
  join,
  loop,
  output,
  thenWire,
  trigger,
  wire,
} from "../../../fixtures/flow-builders.js";

const withFlags = (id: string, flags: Record<string, unknown>) =>
  trigger(id, { settings: { inputs: [], flags } });

const yes = (to: string) => wire("b", "yes", to, "in");
const no = (to: string) => wire("b", "no", to, "in");

const skipsOf = (
  nodes: unknown[],
  wires: unknown[],
  taken: "yes" | "no",
  ineligible: string[] = [],
) => {
  const parsed = flow(
    [withFlags("start", { e2e: true }), branch("b", "e2e"), ...nodes],
    [thenWire("start", "b"), ...wires],
  );
  const eligible = new Set(
    parsed.nodes.map((node) => node.id).filter((id) => !ineligible.includes(id)),
  );
  return branchSkips({
    branchId: "b",
    decisions: new Map([["b", taken]]),
    nodes: parsed.nodes,
    wires: parsed.wires,
    eligible,
  });
};

describe("branchTakes", () => {
  it("takes yes when a flag defaults to true and nothing overrides it", () => {
    expect(branchTakes("e2e", { e2e: true }, {})).toBe("yes");
  });

  it("takes no when the run turns a true flag off", () => {
    expect(branchTakes("e2e", { e2e: true }, { e2e: false })).toBe("no");
  });

  it("takes yes when the run turns a false flag on", () => {
    expect(branchTakes("e2e", { e2e: false }, { e2e: true })).toBe("yes");
  });

  it("takes no when a flag defaults to false and nothing overrides it", () => {
    expect(branchTakes("e2e", { e2e: false }, {})).toBe("no");
  });

  it("throws naming a flag nobody declares", () => {
    expect(() => branchTakes("e2e", { other: true }, {})).toThrow(
      new Error('Branch variable "e2e" is not a yes/no variable on the blueprint.'),
    );
  });
});

const oldTrigger = (id: string, flags: Record<string, unknown>): ManifestNode => ({
  id,
  type: "trigger",
  label: id,
  settings: { inputs: [], flags } as unknown as ManifestNode["settings"],
});

const oldNode = (id: string, type: "agent" | "gate"): ManifestNode => ({
  id,
  type,
  label: id,
  settings: (type === "agent"
    ? { role: "", instructions: "Go.", model: "sonnet", tools: [] }
    : { shown: "Check", skippable: false }) as ManifestNode["settings"],
});

describe("triggerFlags", () => {
  it("returns the trigger's boolean flags", () => {
    expect(triggerFlags([oldTrigger("start", { e2e: true, manual: false })])).toEqual({
      e2e: true,
      manual: false,
    });
  });

  it("drops flags whose default is not a boolean", () => {
    expect(triggerFlags([oldTrigger("start", { e2e: true, ticket: "FD-1", count: 2 })])).toEqual({
      e2e: true,
    });
  });

  it("ignores nodes that are not triggers", () => {
    expect(
      triggerFlags([
        oldNode("p", "agent"),
        oldTrigger("start", { e2e: true }),
        oldNode("s", "gate"),
      ]),
    ).toEqual({ e2e: true });
  });

  it("returns no flags for a flow without a trigger", () => {
    expect(triggerFlags(flow([agent("p")], []).nodes)).toEqual({});
  });

  it("keeps the first trigger's default for a repeated flag", () => {
    expect(
      triggerFlags([
        oldTrigger("first", { e2e: false }),
        oldTrigger("second", { e2e: true, manual: true }),
      ]),
    ).toEqual({ e2e: false, manual: true });
  });
});

describe("branchDecision", () => {
  const workspaceManifest = (values: Record<string, string | boolean>) => ({
    prefix: "fix-login",
    layout: "workspace" as const,
    values,
    nodes: flow([trigger("start"), branch("b", "proceed-e2e")], [thenWire("start", "b")]).nodes,
  });

  it("takes yes when the build's value for the Branch's variable is true", () => {
    expect(
      branchDecision(workspaceManifest({ "proceed-e2e": true }), { variable: "proceed-e2e" }, {}),
    ).toBe("yes");
  });

  it("takes no when the build's value for the Branch's variable is false", () => {
    expect(
      branchDecision(workspaceManifest({ "proceed-e2e": false }), { variable: "proceed-e2e" }, {}),
    ).toBe("no");
  });

  it("keeps the value written into the build over any run flag of the same name", () => {
    expect(
      branchDecision(
        workspaceManifest({ "proceed-e2e": true }),
        { variable: "proceed-e2e" },
        { "proceed-e2e": false },
      ),
    ).toBe("yes");
  });

  it.each([
    ["has no value", {}],
    ["holds text", { "proceed-e2e": "yes" }],
  ])("throws naming the variable when the build %s for it", (_, values) => {
    expect(() =>
      branchDecision(workspaceManifest(values), { variable: "proceed-e2e" }, {}),
    ).toThrow(/proceed-e2e/);
  });

  describe("in an old build's manifest, with no prefix", () => {
    const oldManifest = (e2e: boolean) => ({
      nodes: [
        oldTrigger("start", { e2e }),
        {
          id: "b",
          type: "branch",
          label: "b",
          settings: { flag: "e2e" },
        } as unknown as ManifestNode,
      ],
    });

    it("takes the Trigger flag's default", () => {
      expect(branchDecision(oldManifest(true), { flag: "e2e" }, {})).toBe("yes");
      expect(branchDecision(oldManifest(false), { flag: "e2e" }, {})).toBe("no");
    });

    it("takes the run's stored flag over the Trigger default", () => {
      expect(branchDecision(oldManifest(true), { flag: "e2e" }, { e2e: false })).toBe("no");
      expect(branchDecision(oldManifest(false), { flag: "e2e" }, { e2e: true })).toBe("yes");
    });
  });
});

describe("branchSkips", () => {
  const e2ePaths = {
    nodes: [agent("e2e"), agent("e2e-report"), agent("quick")],
    wires: [yes("e2e"), thenWire("e2e", "e2e-report"), no("quick")],
  };

  it("skips the yes path when the flag is off", () => {
    expect(skipsOf(e2ePaths.nodes, e2ePaths.wires, "no")).toEqual(["e2e", "e2e-report"]);
  });

  it("skips the no path when the flag is on", () => {
    expect(skipsOf(e2ePaths.nodes, e2ePaths.wires, "yes")).toEqual(["quick"]);
  });

  it("never skips the node where both paths rejoin, or anything after it", () => {
    expect(
      skipsOf(
        [agent("a"), agent("bb"), agent("rejoin"), agent("after")],
        [
          yes("a"),
          thenWire("a", "rejoin"),
          no("bb"),
          thenWire("bb", "rejoin"),
          thenWire("rejoin", "after"),
        ],
        "no",
      ),
    ).toEqual(["a"]);
  });

  it.each(["yes", "no"] as const)("skips nothing wired from both ports when taking %s", (taken) => {
    expect(skipsOf([agent("shared")], [yes("shared"), no("shared")], taken)).toEqual([]);
  });

  it("skips the yes path when taking a no port that has no wire", () => {
    expect(skipsOf([agent("a"), agent("c")], [yes("a"), thenWire("a", "c")], "no")).toEqual([
      "a",
      "c",
    ]);
  });

  it("skips nothing when the port not taken has no wire", () => {
    expect(skipsOf([agent("a"), agent("c")], [yes("a"), thenWire("a", "c")], "yes")).toEqual([]);
  });

  it("skips a whole parallel section on the path not taken", () => {
    expect(
      skipsOf(
        [fork("f"), agent("a1"), agent("a2"), join("j"), agent("after"), agent("quick")],
        [
          yes("f"),
          thenWire("f", "a1"),
          thenWire("f", "a2"),
          thenWire("a1", "j"),
          thenWire("a2", "j"),
          thenWire("j", "after"),
          no("quick"),
        ],
        "no",
      ),
    ).toEqual(["f", "a1", "a2", "j", "after"]);
  });

  it.each([
    ["loop", loop("body")],
    ["for each", forEach("body")],
  ])("skips a %s and its unwired body on the path not taken", (_, container) => {
    expect(
      skipsOf(
        [
          container,
          agent("body-1", { parent: "body" }),
          agent("body-2", { parent: "body" }),
          agent("after"),
          agent("quick"),
        ],
        [yes("body"), thenWire("body-1", "body-2"), thenWire("body", "after"), no("quick")],
        "no",
      ),
    ).toEqual(["body", "body-1", "body-2", "after"]);
  });

  it.each([
    ["loop", loop("body")],
    ["for each", forEach("body")],
  ])("skips a %s whose body is wired straight from the path not taken", (_, container) => {
    expect(
      skipsOf(
        [
          agent("e2e"),
          container,
          agent("fix", { parent: "body" }),
          agent("check", { parent: "body" }),
          agent("finish"),
        ],
        [
          yes("e2e"),
          no("fix"),
          thenWire("fix", "check"),
          thenWire("e2e", "finish"),
          thenWire("check", "finish"),
        ],
        "yes",
      ),
    ).toEqual(["body", "fix", "check"]);
  });

  it("skips a loop whose back-edge sits behind a node on the path not taken", () => {
    expect(
      skipsOf(
        [
          agent("e2e"),
          agent("prep"),
          loop("review"),
          agent("fix", { parent: "review" }),
          agent("check", { parent: "review" }),
          agent("finish"),
        ],
        [
          yes("e2e"),
          no("prep"),
          thenWire("prep", "fix"),
          thenWire("fix", "check"),
          thenWire("check", "fix"),
          thenWire("e2e", "finish"),
          thenWire("check", "finish"),
        ],
        "yes",
      ),
    ).toEqual(["prep", "review", "fix", "check"]);
  });

  it("keeps a loop that runs from the trigger even when the path not taken also wires into it", () => {
    expect(
      skipsOf(
        [
          agent("up"),
          loop("review"),
          agent("fix", { parent: "review" }),
          agent("check", { parent: "review" }),
          agent("quick"),
        ],
        [
          thenWire("up", "b"),
          thenWire("up", "fix"),
          thenWire("fix", "check"),
          thenWire("check", "fix"),
          yes("quick"),
          no("check"),
        ],
        "yes",
      ),
    ).toEqual([]);
  });

  it.each(["yes", "no"] as const)("skips nothing in all-types.json when taking %s", (taken) => {
    const allTypes = parseFlow(
      JSON.parse(
        readFileSync(new URL("../../../../examples/all-types.json", import.meta.url), "utf8"),
      ),
    );

    expect(
      branchSkips({
        branchId: "ife2e",
        decisions: new Map([["ife2e", taken]]),
        nodes: allTypes.nodes,
        wires: allTypes.wires,
        eligible: new Set(allTypes.nodes.map((node) => node.id)),
      }),
    ).toEqual([]);
  });

  it("skips the outer loop when the path not taken wires into a loop nested in it", () => {
    expect(
      skipsOf(
        [
          agent("y"),
          loop("outer"),
          loop("inner", { parent: "outer" }),
          agent("x", { parent: "inner" }),
          agent("z"),
        ],
        [yes("y"), no("x"), thenWire("x", "z")],
        "yes",
      ),
    ).toEqual(["outer", "inner", "x", "z"]);
  });

  it("keeps what follows a loop nothing outside wires into, though its body has a wire", () => {
    expect(
      skipsOf(
        [
          agent("y"),
          loop("review"),
          agent("fix", { parent: "review" }),
          agent("check", { parent: "review" }),
          agent("z"),
        ],
        [yes("y"), no("z"), thenWire("fix", "check"), thenWire("check", "z")],
        "yes",
      ),
    ).toEqual([]);
  });

  it("keeps a node that is also fed from upstream of the branch", () => {
    expect(
      skipsOf(
        [agent("up"), agent("a"), agent("mixed")],
        [thenWire("up", "b"), thenWire("up", "mixed"), yes("a"), thenWire("a", "mixed")],
        "no",
      ),
    ).toEqual(["a"]);
  });

  it("leaves out a node that is not eligible but still skips past it", () => {
    expect(skipsOf([agent("a"), agent("c")], [yes("a"), thenWire("a", "c")], "no", ["a"])).toEqual([
      "c",
    ]);
  });

  it("leaves out an output on the path not taken", () => {
    expect(
      skipsOf([agent("a"), output("done")], [yes("a"), thenWire("a", "done")], "no", ["done"]),
    ).toEqual(["a"]);
  });

  it("skips nothing for a branch with no out wires", () => {
    expect(skipsOf([agent("a")], [], "no")).toEqual([]);
  });

  it("stops climbing parents that form a cycle", () => {
    expect(
      skipsOf(
        [
          agent("y"),
          loop("p", { parent: "q" }),
          loop("q", { parent: "p" }),
          agent("x", { parent: "p" }),
        ],
        [yes("y"), no("x")],
        "yes",
      ),
    ).toEqual(["p", "q", "x"]);
  });

  it("throws naming a branch that has not decided", () => {
    const parsed = flow([branch("b", "e2e"), agent("a")], [wire("b", "yes", "a", "in")]);

    expect(() =>
      branchSkips({
        branchId: "b",
        decisions: new Map(),
        nodes: parsed.nodes,
        wires: parsed.wires,
        eligible: new Set(["a"]),
      }),
    ).toThrow(/"b"/);
  });

  describe("after an earlier branch already skipped its path", () => {
    const secondBranchSkips = (nodes: unknown[], wires: unknown[], alreadySkipped: string[]) => {
      const parsed = flow(
        [
          withFlags("start", { one: true, two: true }),
          branch("b1", "one"),
          branch("b2", "two"),
          ...nodes,
        ],
        [thenWire("start", "b1"), ...wires],
      );
      const eligible = new Set(
        parsed.nodes
          .map((node) => node.id)
          .filter((id) => !["start", "b1", "b2", ...alreadySkipped].includes(id)),
      );
      return branchSkips({
        branchId: "b2",
        decisions: new Map([
          ["b1", "yes"],
          ["b2", "yes"],
        ]),
        nodes: parsed.nodes,
        wires: parsed.wires,
        eligible,
      });
    };

    it("skips a node fed only by the earlier skipped path and its own path not taken", () => {
      expect(
        secondBranchSkips(
          [agent("p"), agent("q"), agent("X"), agent("end")],
          [
            wire("b1", "yes", "b2", "in"),
            wire("b1", "no", "p", "in"),
            wire("b2", "yes", "q", "in"),
            wire("b2", "no", "X", "in"),
            thenWire("p", "X"),
            thenWire("q", "end"),
            thenWire("X", "end"),
          ],
          ["p"],
        ),
      ).toEqual(["X"]);
    });

    it("skips a cleanup that both branches' paths not taken lead to", () => {
      expect(
        secondBranchSkips(
          [agent("x"), agent("y"), agent("z"), agent("cleanup"), agent("end")],
          [
            wire("b1", "yes", "x", "in"),
            wire("b1", "no", "y", "in"),
            thenWire("x", "b2"),
            thenWire("y", "cleanup"),
            wire("b2", "yes", "z", "in"),
            wire("b2", "no", "cleanup", "in"),
            thenWire("z", "end"),
            thenWire("cleanup", "end"),
          ],
          ["y"],
        ),
      ).toEqual(["cleanup"]);
    });
  });
});

describe("branchSkips with several Branches", () => {
  type Decisions = ReadonlyMap<string, "yes" | "no">;
  const skipsWith = (
    parsed: ReturnType<typeof flow>,
    branchId: string,
    decisions: Decisions,
    eligible: ReadonlySet<string>,
  ) =>
    branchSkips({
      branchId,
      decisions,
      nodes: parsed.nodes,
      wires: parsed.wires,
      eligible,
    });

  const twoInSeries = () =>
    flow(
      [
        withFlags("start", { b1: true, b2: true }),
        branch("b1", "b1"),
        branch("b2", "b2"),
        agent("q"),
        agent("Z"),
        agent("end"),
      ],
      [
        thenWire("start", "b1"),
        wire("b1", "yes", "b2", "in"),
        wire("b1", "no", "Z", "in"),
        wire("b2", "yes", "q", "in"),
        wire("b2", "no", "Z", "in"),
        thenWire("q", "end"),
        thenWire("Z", "end"),
      ],
    );

  it("skips a node only the not-taken ports of an earlier and the current Branch lead to", () => {
    const parsed = twoInSeries();

    expect(
      skipsWith(
        parsed,
        "b2",
        new Map([
          ["b1", "yes"],
          ["b2", "yes"],
        ]),
        new Set(parsed.nodes.map((node) => node.id)),
      ),
    ).toEqual(["Z"]);
  });

  const series = (count: number) => {
    const ids = Array.from({ length: count }, (_, index) => `b${index + 1}`);
    return flow(
      [
        withFlags("start", Object.fromEntries(ids.map((id) => [id, true]))),
        ...ids.map((id) => branch(id, id)),
        ...ids.map((id) => agent(`off-${id}`)),
        agent("Z"),
        agent("q"),
        agent("end"),
      ],
      [
        thenWire("start", "b1"),
        ...ids.flatMap((id, index) => [
          wire(id, "yes", ids[index + 1] ?? "q", "in"),
          wire(id, "no", `off-${id}`, "in"),
          thenWire(`off-${id}`, "Z"),
        ]),
        thenWire("q", "end"),
        thenWire("Z", "end"),
      ],
    );
  };

  const shapes: [string, () => ReturnType<typeof flow>][] = [
    ["two in series", twoInSeries],
    ["three in series sharing one join", () => series(3)],
    [
      "nested under both ports",
      () =>
        flow(
          [
            withFlags("start", { b1: true, b2: true, b3: true }),
            branch("b1", "b1"),
            branch("b2", "b2"),
            branch("b3", "b3"),
            agent("a"),
            agent("c"),
            agent("d"),
            agent("j"),
            agent("end"),
          ],
          [
            thenWire("start", "b1"),
            wire("b1", "yes", "b2", "in"),
            wire("b1", "no", "b3", "in"),
            wire("b2", "yes", "a", "in"),
            wire("b2", "no", "c", "in"),
            wire("b3", "yes", "c", "in"),
            wire("b3", "no", "d", "in"),
            thenWire("a", "j"),
            thenWire("c", "j"),
            thenWire("d", "j"),
            thenWire("j", "end"),
          ],
        ),
    ],
    [
      "rejoin before a second Branch with a cross wire",
      () =>
        flow(
          [
            withFlags("start", { b1: true, b2: true }),
            branch("b1", "b1"),
            agent("x"),
            agent("y"),
            agent("m"),
            branch("b2", "b2"),
            agent("u"),
            agent("v"),
            agent("end"),
          ],
          [
            thenWire("start", "b1"),
            wire("b1", "yes", "x", "in"),
            wire("b1", "no", "y", "in"),
            thenWire("x", "m"),
            thenWire("y", "m"),
            thenWire("y", "v"),
            thenWire("m", "b2"),
            wire("b2", "yes", "u", "in"),
            wire("b2", "no", "v", "in"),
            thenWire("u", "end"),
            thenWire("v", "end"),
          ],
        ),
    ],
    [
      "a loop on one path before a second Branch",
      () =>
        flow(
          [
            withFlags("start", { b1: true, b2: true }),
            branch("b1", "b1"),
            agent("e"),
            agent("prep"),
            loop("review"),
            agent("fix", { parent: "review" }),
            agent("check", { parent: "review" }),
            branch("b2", "b2"),
            agent("alt"),
            agent("fin"),
          ],
          [
            thenWire("start", "b1"),
            wire("b1", "yes", "e", "in"),
            wire("b1", "no", "prep", "in"),
            thenWire("prep", "fix"),
            thenWire("fix", "check"),
            thenWire("check", "fix"),
            thenWire("check", "b2"),
            thenWire("e", "b2"),
            wire("b2", "yes", "fin", "in"),
            wire("b2", "no", "alt", "in"),
            thenWire("alt", "fin"),
          ],
        ),
    ],
    [
      "a loop nested in a loop on one path",
      () =>
        flow(
          [
            withFlags("start", { b1: true, b2: true }),
            branch("b1", "b1"),
            branch("b2", "b2"),
            loop("outer"),
            loop("inner", { parent: "outer" }),
            agent("x", { parent: "inner" }),
            agent("q"),
            agent("z"),
            agent("end"),
          ],
          [
            thenWire("start", "b1"),
            wire("b1", "yes", "b2", "in"),
            wire("b1", "no", "x", "in"),
            thenWire("x", "z"),
            wire("b2", "yes", "q", "in"),
            wire("b2", "no", "z", "in"),
            thenWire("q", "end"),
            thenWire("z", "end"),
          ],
        ),
    ],
    [
      "a loop nothing outside wires into, feeding a node both not-taken ports lead to",
      () =>
        flow(
          [
            withFlags("start", { b1: true, b2: true }),
            branch("b1", "b1"),
            branch("b2", "b2"),
            loop("review"),
            agent("fix", { parent: "review" }),
            agent("check", { parent: "review" }),
            agent("q"),
            agent("z"),
            agent("end"),
          ],
          [
            thenWire("start", "b1"),
            wire("b1", "yes", "b2", "in"),
            wire("b1", "no", "z", "in"),
            thenWire("fix", "check"),
            thenWire("check", "fix"),
            thenWire("check", "z"),
            wire("b2", "yes", "q", "in"),
            wire("b2", "no", "z", "in"),
            thenWire("q", "end"),
            thenWire("z", "end"),
          ],
        ),
    ],
  ];

  const unreachable = (parsed: ReturnType<typeof flow>, flags: Record<string, boolean>) => {
    const branches = new Set(
      parsed.nodes.filter((node) => node.type === "branch").map((node) => node.id),
    );
    const followed = parsed.wires.filter(
      (each) =>
        each.kind === "then" &&
        (!branches.has(each.from.node) ||
          each.from.port === branchTakes(each.from.node, flags, {})),
    );
    const membersOf = (id: string): string[] => [
      id,
      ...parsed.nodes.filter((node) => node.parent === id).flatMap((node) => membersOf(node.id)),
    ];
    const units = parsed.nodes
      .filter((node) => node.parent === undefined)
      .map((node) => new Set(membersOf(node.id)));
    const unitHolding = (id: string) => units.find((unit) => unit.has(id)) ?? new Set<string>();
    const thenWires = parsed.wires.filter((each) => each.kind === "then");
    const enteredFromOutside = (unit: Set<string>) =>
      thenWires.some((each) => unit.has(each.to.node) && !unit.has(each.from.node));
    const reached = new Set<string>();
    const pending = units.filter((unit) => !enteredFromOutside(unit));
    for (let unit = pending.pop(); unit !== undefined; unit = pending.pop()) {
      const fresh = [...unit].filter((id) => !reached.has(id));
      if (fresh.length === 0) continue;
      for (const id of unit) reached.add(id);
      pending.push(
        ...followed
          .filter((each) => unit.has(each.from.node))
          .map((each) => unitHolding(each.to.node)),
      );
    }
    return parsed.nodes.map((node) => node.id).filter((id) => !reached.has(id));
  };

  const runBranches = (parsed: ReturnType<typeof flow>, flags: Record<string, boolean>) => {
    const ids = parsed.nodes.map((node) => node.id);
    const skipped = new Set<string>();
    const decisions = new Map<string, "yes" | "no">();
    for (const node of parsed.nodes) {
      if (node.type !== "branch" || skipped.has(node.id)) continue;
      decisions.set(node.id, branchTakes(node.id, flags, {}));
      const eligible = new Set(ids.filter((id) => !skipped.has(id)));
      for (const id of skipsWith(parsed, node.id, decisions, eligible)) skipped.add(id);
    }
    return ids.filter((id) => skipped.has(id));
  };

  const combinations = (names: string[]): Record<string, boolean>[] =>
    names.reduce<Record<string, boolean>[]>(
      (all, name) => all.flatMap((flags) => [true, false].map((on) => ({ ...flags, [name]: on }))),
      [{}],
    );

  it.each(shapes)(
    "skips exactly what no taken port reaches, for every flag combination: %s",
    (_, shape) => {
      const parsed = shape();
      const names = parsed.nodes.filter((node) => node.type === "branch").map((node) => node.id);

      for (const flags of combinations(names)) {
        expect({ flags, skipped: runBranches(parsed, flags) }).toEqual({
          flags,
          skipped: unreachable(parsed, flags),
        });
      }
    },
  );
});
