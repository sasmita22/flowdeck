import { describe, expect, it } from "vitest";
import type { ActivityEntry } from "../../../src/core/run/activity.js";
import { costReport } from "../../../src/core/run/cost.js";
import { plainReason } from "../../../src/core/run/failure.js";
import { pipelineOf } from "../../../src/core/run/pipeline.js";
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

    it("gives no round of a Loop child tokens or cost, its usage being charged once after the rounds", () => {
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
