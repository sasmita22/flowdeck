import { describe, expect, it } from "vitest";
import type { ActivityEntry } from "../../../src/core/run/activity.js";
import { costReport } from "../../../src/core/run/cost.js";
import { plainReason } from "../../../src/core/run/failure.js";
import { pipelineOf, pipelineSchema, stageActivityOf } from "../../../src/core/run/pipeline.js";
import type { RunEvent } from "../../../src/core/run/run-events.js";
import type { StoredEvent } from "../../../src/core/run/store.js";

type Source = { id: string; type: string; label: string; parent?: string };
type Link = {
  kind: "then";
  from: { node: string; port: string };
  to: { node: string; port: string };
};

const start = Date.parse("2026-11-15T10:00:00.000Z");
const at = (seconds: number) => start + seconds * 1000;

const node = (id: string, type = "agent", parent?: string): Source => ({
  id,
  type,
  label: `${id} label`,
  ...(parent === undefined ? {} : { parent }),
});

const then = (from: string, to: string): Link => ({
  kind: "then",
  from: { node: from, port: "out" },
  to: { node: to, port: "in" },
});

const stored = (entries: [string, number, RunEvent][]): StoredEvent[] =>
  entries.map(([nodeId, seconds, event], index) => ({
    ...event,
    nodeId,
    seq: index + 1,
    time: new Date(at(seconds)).toISOString(),
  }));

const tool = (id: number, nodeId: string): ActivityEntry => ({
  id,
  nodeId,
  at: at(id),
  kind: "tool",
  tool: "Edit",
  summary: `edit ${id}`,
});

const pipeline = (
  nodes: Source[],
  wires: Link[],
  events: StoredEvent[] = [],
  activity: ActivityEntry[] = [],
  now = at(60),
) =>
  pipelineOf(
    nodes as Parameters<typeof pipelineOf>[0],
    wires as Parameters<typeof pipelineOf>[1],
    events,
    activity,
    costReport({ nodeIds: nodes.map((source) => source.id), events, pending: [], now }),
  );

type Round = { round: number; item?: string; items: unknown[] };
type Shape = string | { id: string; rounds: ShapeRound[] } | { lanes: Shape[][] };
type ShapeRound = { round: number; item?: string; items: Shape[] };
type Seen = { nodeId?: string; lanes?: unknown[][]; rounds?: Round[] };

const shapeOf = (items: readonly unknown[]): Shape[] =>
  items.map((raw) => {
    const item = raw as Seen;
    if (item.lanes !== undefined) return { lanes: item.lanes.map(shapeOf) };
    if (item.rounds !== undefined && item.rounds.length > 0) {
      return {
        id: item.nodeId ?? "",
        rounds: item.rounds.map((round) => ({
          round: round.round,
          ...(round.item === undefined ? {} : { item: round.item }),
          items: shapeOf(round.items),
        })),
      };
    }
    return item.nodeId ?? "";
  });

type Stage = Extract<ReturnType<typeof pipelineOf>[number], { nodeId: string }>;

const stageIn = (items: readonly unknown[], nodeId: string): Stage => {
  const found = items.find((item) => (item as Seen).nodeId === nodeId);
  if (found === undefined) throw new Error(`no stage ${nodeId}`);
  return found as Stage;
};

const roundsOf = (items: readonly unknown[], nodeId: string): Round[] =>
  (stageIn(items, nodeId) as unknown as Seen).rounds ?? [];

describe("pipelineOf", () => {
  describe("order and grouping", () => {
    it("lists a straight chain in run order, whatever the order the nodes are stored in", () => {
      const items = pipeline(
        [node("c"), node("a"), node("stop", "output"), node("b"), node("start", "trigger")],
        [then("start", "a"), then("a", "b"), then("b", "c"), then("c", "stop")],
      );

      expect(shapeOf(items)).toEqual(["start", "a", "b", "c", "stop"]);
    });

    it("groups the lanes between a Fork and its Join side by side, not as a chain", () => {
      const items = pipeline(
        [
          node("start", "trigger"),
          node("split", "fork"),
          node("a"),
          node("b1"),
          node("b2"),
          node("meet", "join"),
          node("stop", "output"),
        ],
        [
          then("start", "split"),
          then("split", "a"),
          then("split", "b1"),
          then("b1", "b2"),
          then("a", "meet"),
          then("b2", "meet"),
          then("meet", "stop"),
        ],
      );

      expect(shapeOf(items)).toEqual([
        "start",
        "split",
        { lanes: [["a"], ["b1", "b2"]] },
        "meet",
        "stop",
      ]);
    });

    it("lists a Loop's children once per round, each round with its own status", () => {
      const nodes = [
        node("start", "trigger"),
        node("review", "loop"),
        node("fix", "agent", "review"),
        node("check", "agent", "review"),
        node("stop", "output"),
      ];
      const events = stored([
        ["start", 0, { kind: "running" }],
        ["start", 0, { kind: "done" }],
        ["review", 0, { kind: "running" }],
        ["review", 0, { kind: "round", payload: { round: 1 } }],
        ["fix", 1, { kind: "sent" }],
        ["fix", 2, { kind: "done" }],
        ["check", 3, { kind: "sent" }],
        ["check", 4, { kind: "done" }],
        ["review", 5, { kind: "round", payload: { round: 2 } }],
        ["fix", 5, { kind: "reset" }],
        ["check", 5, { kind: "reset" }],
        ["fix", 6, { kind: "sent" }],
        ["fix", 7, { kind: "done" }],
        ["check", 8, { kind: "sent" }],
      ]);

      const items = pipeline(
        nodes,
        [then("start", "review"), then("fix", "check"), then("review", "stop")],
        events,
      );

      expect(shapeOf(items)).toEqual([
        "start",
        {
          id: "review",
          rounds: [
            { round: 1, items: ["fix", "check"] },
            { round: 2, items: ["fix", "check"] },
          ],
        },
        "stop",
      ]);
      const [first, second] = roundsOf(items, "review");
      expect(stageIn(first?.items ?? [], "check").status).toBe("done");
      expect(stageIn(second?.items ?? [], "check").status).toBe("sent");
    });

    it("lists a For each's children once per round, labelled with that round's item", () => {
      const events = stored([
        ["each", 0, { kind: "running" }],
        ["each", 0, { kind: "round", payload: { round: 1, items: ["unit one", "unit two"] } }],
        ["work", 1, { kind: "sent" }],
        ["work", 2, { kind: "done" }],
        ["each", 3, { kind: "round", payload: { round: 2 } }],
        ["work", 3, { kind: "reset" }],
        ["work", 4, { kind: "sent" }],
      ]);

      const items = pipeline(
        [
          node("start", "trigger"),
          node("each", "foreach"),
          node("work", "agent", "each"),
          node("stop", "output"),
        ],
        [then("start", "each"), then("each", "stop")],
        events,
      );

      expect(shapeOf(items)).toEqual([
        "start",
        {
          id: "each",
          rounds: [
            { round: 1, item: "unit one", items: ["work"] },
            { round: 2, item: "unit two", items: ["work"] },
          ],
        },
        "stop",
      ]);
    });

    it("nests a Loop inside a Fork lane", () => {
      const items = pipeline(
        [
          node("start", "trigger"),
          node("split", "fork"),
          node("review", "loop"),
          node("fix", "agent", "review"),
          node("b"),
          node("meet", "join"),
          node("stop", "output"),
        ],
        [
          then("start", "split"),
          then("split", "review"),
          then("split", "b"),
          then("review", "meet"),
          then("b", "meet"),
          then("meet", "stop"),
        ],
        stored([["review", 0, { kind: "round", payload: { round: 1 } }]]),
      );

      expect(shapeOf(items)).toEqual([
        "start",
        "split",
        { lanes: [[{ id: "review", rounds: [{ round: 1, items: ["fix"] }] }], ["b"]] },
        "meet",
        "stop",
      ]);
    });

    it("nests a Fork inside a Loop round", () => {
      const items = pipeline(
        [
          node("start", "trigger"),
          node("review", "loop"),
          node("split", "fork", "review"),
          node("a", "agent", "review"),
          node("b", "agent", "review"),
          node("meet", "join", "review"),
          node("stop", "output"),
        ],
        [
          then("start", "review"),
          then("split", "a"),
          then("split", "b"),
          then("a", "meet"),
          then("b", "meet"),
          then("review", "stop"),
        ],
        stored([["review", 0, { kind: "round", payload: { round: 1 } }]]),
      );

      expect(shapeOf(items)).toEqual([
        "start",
        {
          id: "review",
          rounds: [{ round: 1, items: ["split", { lanes: [["a"], ["b"]] }, "meet"] }],
        },
        "stop",
      ]);
    });

    it("lists a Loop's children as waiting before its first round", () => {
      const items = pipeline(
        [
          node("start", "trigger"),
          node("review", "loop"),
          node("fix", "agent", "review"),
          node("check", "agent", "review"),
          node("stop", "output"),
        ],
        [then("start", "review"), then("fix", "check"), then("review", "stop")],
        stored([["start", 0, { kind: "running" }]]),
      );

      expect(shapeOf(items)).toEqual([
        "start",
        { id: "review", rounds: [{ round: 1, items: ["fix", "check"] }] },
        "stop",
      ]);
      const [only] = roundsOf(items, "review");
      for (const id of ["fix", "check"])
        expect(stageIn(only?.items ?? [], id).status).toBe("waiting");
    });

    it("lists a Fork inside a Loop as waiting stages before the Loop's first round", () => {
      const items = pipeline(
        [
          node("start", "trigger"),
          node("review", "loop"),
          node("split", "fork", "review"),
          node("a", "agent", "review"),
          node("inner", "loop", "review"),
          node("deep", "agent", "inner"),
          node("meet", "join", "review"),
          node("stop", "output"),
        ],
        [
          then("start", "review"),
          then("split", "a"),
          then("split", "inner"),
          then("a", "meet"),
          then("inner", "meet"),
          then("review", "stop"),
        ],
      );

      expect(shapeOf(items)).toEqual([
        "start",
        {
          id: "review",
          rounds: [
            {
              round: 1,
              items: [
                "split",
                { lanes: [["a"], [{ id: "inner", rounds: [{ round: 1, items: ["deep"] }] }]] },
                "meet",
              ],
            },
          ],
        },
        "stop",
      ]);
      const [round] = roundsOf(items, "review");
      const placed = (each: readonly unknown[]): Stage[] =>
        each.flatMap((raw) => {
          const item = raw as Seen;
          if (item.lanes !== undefined) return item.lanes.flatMap(placed);
          return [raw as Stage, ...(item.rounds ?? []).flatMap((inner) => placed(inner.items))];
        });
      expect(placed(round?.items ?? []).map((stage) => [stage.nodeId, stage.status])).toEqual([
        ["split", "waiting"],
        ["a", "waiting"],
        ["inner", "waiting"],
        ["deep", "waiting"],
        ["meet", "waiting"],
      ]);
    });
  });

  describe("failure and timing", () => {
    const chain = [node("start", "trigger"), node("a"), node("b"), node("stop", "output")];
    const links = [then("start", "a"), then("a", "b"), then("b", "stop")];

    it("gives a failed stage its plain reason, its retry count, and its first start to last finish", () => {
      const message = "a failed: tests still break";
      const items = pipeline(
        chain,
        links,
        stored([
          ["a", 0, { kind: "sent" }],
          ["a", 10, { kind: "failed", payload: { message: "a failed: tests break" } }],
          ["a", 11, { kind: "retry" }],
          ["a", 12, { kind: "running" }],
          ["a", 20, { kind: "failed", payload: { message } }],
        ]),
      );

      expect(stageIn(items, "a")).toMatchObject({
        status: "failed",
        reason: plainReason("a", message),
        retries: 1,
        startedAt: at(0),
        finishedAt: at(20),
        ms: 20_000,
      });
    });

    it("gives a running stage its start and no duration, and a pending stage no times", () => {
      const items = pipeline(chain, links, stored([["a", 5, { kind: "running" }]]), [], at(60));

      const running = stageIn(items, "a");
      expect(running.status).toBe("running");
      expect(running.startedAt).toBe(at(5));
      expect(running.finishedAt).toBeUndefined();
      expect(running.ms).toBeUndefined();

      const pending = stageIn(items, "b");
      expect(pending.status).toBe("waiting");
      expect(pending.startedAt).toBeUndefined();
      expect(pending.finishedAt).toBeUndefined();
      expect(pending.ms).toBeUndefined();
      expect(pending.retries).toBe(0);
    });
  });

  describe("per-stage data", () => {
    const nodes = [
      node("start", "trigger"),
      node("a"),
      node("approve", "gate"),
      node("stop", "output"),
    ];
    const links = [then("start", "a"), then("a", "approve"), then("approve", "stop")];
    const events = stored([
      ["a", 0, { kind: "sent" }],
      ["a", 5, { kind: "usage", payload: { messages: ["m1"] }, tokens: 1200, cost: 0.5 }],
      ["a", 6, { kind: "budget", payload: { step: "paused", spend: 2, budget: 1 } }],
      ["a", 9, { kind: "done", payload: { stopMessage: "All green." } }],
      ["approve", 10, { kind: "needs-you" }],
      ["approve", 12, { kind: "decided", payload: { nodeId: "approve", decision: "approved" } }],
      ["approve", 12, { kind: "done" }],
    ]);
    const activity = [tool(1, "a"), tool(2, "approve"), tool(3, "a")];

    it("gives a stage its tokens and cost, budget pauses, final reply, timeline and own activity", () => {
      const a = stageIn(pipeline(nodes, links, events, activity), "a");

      expect(a).toMatchObject({
        nodeId: "a",
        type: "agent",
        label: "a label",
        status: "done",
        tokens: 1200,
        cost: 0.5,
        budgetPauses: [{ step: "paused", spend: 2, budget: 1 }],
        reply: "All green.",
        decisions: [],
      });
      expect(a.timeline.map((event: { kind: string }) => event.kind)).toEqual([
        "sent",
        "usage",
        "budget",
        "done",
      ]);
      expect(a.activity).toEqual([tool(1, "a"), tool(3, "a")]);
    });

    it("gives a gate its decisions, no reply and only its own activity", () => {
      const approve = stageIn(pipeline(nodes, links, events, activity), "approve");

      expect(approve.decisions).toEqual([{ nodeId: "approve", decision: "approved" }]);
      expect(approve.reply).toBeUndefined();
      expect(approve.activity).toEqual([tool(2, "approve")]);
    });

    it("gives no round of a Loop child tokens or cost in a run whose usage was charged with no round", () => {
      const looped = [
        node("start", "trigger"),
        node("review", "loop"),
        node("fix", "agent", "review"),
      ];
      const items = pipeline(
        looped,
        [then("start", "review")],
        stored([
          ["start", 0, { kind: "running" }],
          ["start", 0, { kind: "done" }],
          ["review", 0, { kind: "running" }],
          ["review", 0, { kind: "round", payload: { round: 1 } }],
          ["fix", 1, { kind: "sent" }],
          ["fix", 2, { kind: "done" }],
          ["review", 3, { kind: "round", payload: { round: 2 } }],
          ["fix", 3, { kind: "reset" }],
          ["fix", 4, { kind: "sent" }],
          ["fix", 5, { kind: "done" }],
          ["review", 6, { kind: "done" }],
          [
            "fix",
            7,
            { kind: "usage", payload: { messages: ["m1", "m2"] }, tokens: 200, cost: 0.03 },
          ],
        ]),
      );

      const fixes = roundsOf(items, "review").map((round) => stageIn(round.items, "fix"));
      expect(fixes).toHaveLength(2);
      for (const fix of fixes) {
        expect(fix.tokens).toBeUndefined();
        expect(fix.cost).toBeUndefined();
        expect(fix.timeline.map((event) => event.kind)).not.toContain("usage");
      }
      expect(stageIn(items, "review")).toMatchObject({ tokens: 0, cost: 0 });
      for (const round of roundsOf(items, "review")) {
        expect((round as { tokens?: number }).tokens).toBeUndefined();
        expect((round as { cost?: number }).cost).toBeUndefined();
      }
    });

    describe("a run charged per round", () => {
      const line = (nodeId: string, rounds: [number, number, number][] = []) => ({
        nodeId,
        tokens: rounds.reduce((sum, [, tokens]) => sum + tokens, 0),
        cost: rounds.reduce((sum, [, , cost]) => sum + cost, 0),
        ms: null,
        ...(rounds.length === 0
          ? {}
          : { rounds: rounds.map(([round, tokens, cost]) => ({ round, tokens, cost })) }),
      });
      const report = (lines: ReturnType<typeof line>[]) =>
        ({
          nodes: lines,
          total: {
            tokens: lines.reduce((sum, each) => sum + each.tokens, 0),
            cost: lines.reduce((sum, each) => sum + each.cost, 0),
            ms: 0,
          },
        }) as Parameters<typeof pipelineOf>[4];

      const loopNodes = [
        node("start", "trigger"),
        node("review", "loop"),
        node("fix", "agent", "review"),
        node("check", "agent", "review"),
      ];
      const loopEvents = stored([
        ["start", 0, { kind: "running" }],
        ["start", 0, { kind: "done" }],
        ["review", 0, { kind: "running" }],
        ["review", 0, { kind: "round", payload: { round: 1 } }],
        ["fix", 1, { kind: "sent" }],
        ["fix", 2, { kind: "done" }],
        ["check", 2, { kind: "sent" }],
        ["check", 3, { kind: "done" }],
        ["review", 4, { kind: "round", payload: { round: 2 } }],
        ["fix", 4, { kind: "reset" }],
        ["check", 4, { kind: "reset" }],
        ["fix", 5, { kind: "sent" }],
        ["fix", 6, { kind: "done" }],
        ["check", 6, { kind: "sent" }],
        ["check", 7, { kind: "done" }],
        ["review", 8, { kind: "done" }],
        [
          "fix",
          9,
          { kind: "usage", payload: { messages: ["f1"], round: 1 }, tokens: 100, cost: 0.02 },
        ],
        [
          "fix",
          9,
          { kind: "usage", payload: { messages: ["f2"], round: 2 }, tokens: 200, cost: 0.03 },
        ],
        [
          "check",
          9,
          { kind: "usage", payload: { messages: ["c1"], round: 1 }, tokens: 50, cost: 0.01 },
        ],
      ]);
      const loopItems = () =>
        pipelineOf(
          loopNodes as Parameters<typeof pipelineOf>[0],
          [then("start", "review"), then("fix", "check")] as Parameters<typeof pipelineOf>[1],
          loopEvents,
          [],
          report([
            line("start"),
            line("review"),
            line("fix", [
              [1, 100, 0.02],
              [2, 200, 0.03],
            ]),
            line("check", [[1, 50, 0.01]]),
          ]),
        );

      it("gives each Loop round its total and each stage in it that node's cost for the round", () => {
        const items = loopItems();

        const [first, second] = roundsOf(items, "review") as (Round & {
          tokens?: number;
          cost?: number;
        })[];
        expect(first?.tokens).toBe(150);
        expect(first?.cost).toBeCloseTo(0.03, 12);
        expect(second?.tokens).toBe(200);
        expect(second?.cost).toBeCloseTo(0.03, 12);
        expect(stageIn(first?.items ?? [], "fix")).toMatchObject({ tokens: 100, cost: 0.02 });
        expect(stageIn(first?.items ?? [], "check")).toMatchObject({ tokens: 50, cost: 0.01 });
        expect(stageIn(second?.items ?? [], "fix")).toMatchObject({ tokens: 200, cost: 0.03 });
        const idle = stageIn(second?.items ?? [], "check");
        expect(idle.tokens).toBeUndefined();
        expect(idle.cost).toBeUndefined();
        expect(stageIn(items, "review")).toMatchObject({ tokens: 0, cost: 0 });
      });

      it("gives each For each round its total and its stage's cost for the round", () => {
        const items = pipelineOf(
          [
            node("start", "trigger"),
            node("each", "foreach"),
            node("work", "agent", "each"),
          ] as Parameters<typeof pipelineOf>[0],
          [then("start", "each")] as Parameters<typeof pipelineOf>[1],
          stored([
            ["each", 0, { kind: "round", payload: { round: 1, items: ["one", "two"] } }],
            ["work", 1, { kind: "sent" }],
            ["work", 2, { kind: "done" }],
            ["each", 3, { kind: "round", payload: { round: 2 } }],
            ["work", 3, { kind: "reset" }],
            ["work", 4, { kind: "sent" }],
            ["work", 5, { kind: "done" }],
          ]),
          [],
          report([
            line("start"),
            line("each"),
            line("work", [
              [1, 10, 0.001],
              [2, 20, 0.002],
            ]),
          ]),
        );

        const rounds = roundsOf(items, "each") as (Round & { tokens?: number; cost?: number })[];
        expect(rounds.map(({ round, tokens, cost }) => ({ round, tokens, cost }))).toEqual([
          { round: 1, tokens: 10, cost: 0.001 },
          { round: 2, tokens: 20, cost: 0.002 },
        ]);
        expect(rounds.map((round) => stageIn(round.items, "work").cost)).toEqual([0.001, 0.002]);
      });

      it("adds the stages of a round's parallel lanes into the round total", () => {
        const items = pipelineOf(
          [
            node("start", "trigger"),
            node("review", "loop"),
            node("split", "fork", "review"),
            node("a", "agent", "review"),
            node("b", "agent", "review"),
            node("meet", "join", "review"),
          ] as Parameters<typeof pipelineOf>[0],
          [
            then("start", "review"),
            then("split", "a"),
            then("split", "b"),
            then("a", "meet"),
            then("b", "meet"),
          ] as Parameters<typeof pipelineOf>[1],
          stored([["review", 0, { kind: "round", payload: { round: 1 } }]]),
          [],
          report([
            line("start"),
            line("review"),
            line("split"),
            line("a", [[1, 30, 0.003]]),
            line("b", [[1, 40, 0.004]]),
            line("meet"),
          ]),
        );

        const [first] = roundsOf(items, "review") as (Round & { tokens?: number; cost?: number })[];
        expect(first?.tokens).toBe(70);
        expect(first?.cost).toBeCloseTo(0.007, 12);
      });

      it("keeps round tokens and cost through the pipeline schema", () => {
        const [first] = roundsOf(pipelineSchema.parse(loopItems()), "review") as (Round & {
          tokens?: number;
          cost?: number;
        })[];

        expect(first?.tokens).toBe(150);
        expect(first?.cost).toBeCloseTo(0.03, 12);
      });
    });

    it("gives each round only its own activity, an entry stamped as the next round starts closing the round before", () => {
      const items = pipeline(
        [
          node("start", "trigger"),
          node("each", "foreach"),
          node("work", "agent", "each"),
          node("stop", "output"),
        ],
        [then("start", "each"), then("each", "stop")],
        stored([
          ["each", 0, { kind: "round", payload: { round: 1, items: ["one", "two"] } }],
          ["work", 1, { kind: "sent" }],
          ["work", 2, { kind: "done" }],
          ["each", 2, { kind: "round", payload: { round: 2 } }],
          ["work", 2, { kind: "reset" }],
          ["work", 3, { kind: "sent" }],
          ["work", 4, { kind: "done" }],
        ]),
        [tool(2, "work"), tool(4, "work")],
      );

      const [first, second] = roundsOf(items, "each");
      expect(stageIn(first?.items ?? [], "work").activity).toEqual([tool(2, "work")]);
      expect(stageIn(second?.items ?? [], "work").activity).toEqual([tool(4, "work")]);
    });
  });
});

describe("stage activity windows", () => {
  type Windowed = { activityFrom?: number; activityTo?: number };
  type StageLike = { nodeId: string } & Windowed;

  const foreachItems = () =>
    pipeline(
      [
        node("start", "trigger"),
        node("each", "foreach"),
        node("work", "agent", "each"),
        node("stop", "output"),
      ],
      [then("start", "each"), then("each", "stop")],
      stored([
        ["each", 0, { kind: "round", payload: { round: 1, items: ["one", "two", "three"] } }],
        ["work", 1, { kind: "sent" }],
        ["work", 2, { kind: "done" }],
        ["each", 2, { kind: "round", payload: { round: 2 } }],
        ["work", 2, { kind: "reset" }],
        ["work", 3, { kind: "sent" }],
        ["work", 4, { kind: "done" }],
        ["each", 4, { kind: "round", payload: { round: 3 } }],
        ["work", 4, { kind: "reset" }],
        ["work", 5, { kind: "sent" }],
      ]),
      [tool(2, "work"), tool(4, "work"), tool(5, "work")],
    );

  it("keeps only the stage's own entries in input order when the stage has no window", () => {
    const entries = [tool(3, "a"), tool(2, "b"), tool(1, "a")];

    expect(stageActivityOf(entries, { nodeId: "a" })).toEqual([tool(3, "a"), tool(1, "a")]);
  });

  it("keeps entries after the window's start up to and including its end", () => {
    const entries = [tool(5, "a"), tool(4, "a"), tool(3, "b"), tool(2, "a"), tool(1, "a")];

    expect(
      stageActivityOf(entries, { nodeId: "a", activityFrom: at(1), activityTo: at(4) }),
    ).toEqual([tool(4, "a"), tool(2, "a")]);
  });

  it("bounds a window on one side only when only that side is set", () => {
    const entries = [tool(3, "a"), tool(2, "a"), tool(1, "a")];

    expect(stageActivityOf(entries, { nodeId: "a", activityTo: at(2) })).toEqual([
      tool(2, "a"),
      tool(1, "a"),
    ]);
    expect(stageActivityOf(entries, { nodeId: "a", activityFrom: at(2) })).toEqual([tool(3, "a")]);
  });

  it("gives a round stage the finite edges of its round's window and a whole-run stage none", () => {
    const items = foreachItems();
    const [first, second, third] = roundsOf(items, "each");
    const work = (round: Round | undefined) =>
      stageIn(round?.items ?? [], "work") as unknown as Windowed;

    expect(work(first)).toMatchObject({ activityTo: at(2) });
    expect(work(first)).not.toHaveProperty("activityFrom");
    expect(work(second)).toMatchObject({ activityFrom: at(2), activityTo: at(4) });
    expect(work(third)).toMatchObject({ activityFrom: at(4) });
    expect(work(third)).not.toHaveProperty("activityTo");
    expect(stageIn(items, "each")).not.toHaveProperty("activityFrom");
    expect(stageIn(items, "each")).not.toHaveProperty("activityTo");
  });

  it("selects the same activity from a whole feed as the pipeline gives each round", () => {
    const items = foreachItems();
    const feed = [tool(5, "work"), tool(4, "work"), tool(2, "work")];
    const rounds = roundsOf(items, "each");

    expect(
      rounds.map((round) =>
        stageActivityOf(feed, stageIn(round.items, "work") as unknown as StageLike),
      ),
    ).toEqual([[tool(2, "work")], [tool(4, "work")], [tool(5, "work")]]);
  });

  it("parses stages with and without window edges through the pipeline schema", () => {
    const parsed = pipelineSchema.parse(JSON.parse(JSON.stringify(foreachItems())));
    const [first, second] = roundsOf(parsed, "each");

    expect(stageIn(second?.items ?? [], "work")).toMatchObject({
      activityFrom: at(2),
      activityTo: at(4),
    });
    expect(stageIn(first?.items ?? [], "work")).not.toHaveProperty("activityFrom");
    expect(stageIn(parsed, "each")).not.toHaveProperty("activityTo");
  });
});
