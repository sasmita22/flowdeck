import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TranscriptUsage } from "../../../src/adapters/claude/transcript-usage.js";
import { costOf, type UsageEntry } from "../../../src/core/run/budget.js";
import {
  chargeUsage,
  costReport,
  costReportSchema,
  usageOwners,
} from "../../../src/core/run/cost.js";
import type { RunEvent } from "../../../src/core/run/run-events.js";
import type { StoredEvent } from "../../../src/core/run/store.js";

const fork = (id: string) => ({ id, type: "fork" });
const agent = (id: string, piece?: string) => ({
  id,
  type: "agent",
  ...(piece === undefined ? {} : { piece }),
});
const join_ = (id: string) => ({ id, type: "join" });

const transcript = fileURLToPath(
  new URL("../../fixtures/transcripts/two-prompts.jsonl", import.meta.url),
);

const fixtureEntries = () =>
  new TranscriptUsage({ findTranscript: async () => transcript }).entries("session-1");

const at = (second: number) => new Date(Date.parse("2026-11-02T10:00:00Z") + second * 1000);

function stored(entries: [number, string, RunEvent][]): StoredEvent[] {
  return entries.map(([second, nodeId, event], i) => ({
    ...event,
    nodeId,
    seq: i + 1,
    time: at(second).toISOString(),
  }));
}

const twoTurns = stored([
  [0, "t", { kind: "running" }],
  [0, "t", { kind: "done" }],
  [1, "p1", { kind: "sent" }],
  [10, "p1", { kind: "done" }],
  [15, "s1", { kind: "running" }],
  [16, "s1", { kind: "done" }],
  [20, "p2", { kind: "sent" }],
  [30, "p2", { kind: "done" }],
]);

const turnNodes = new Set(["p1", "p2"]);

const tokensOf = (entry: UsageEntry) =>
  entry.inputTokens +
  entry.outputTokens +
  entry.cacheWrite5mTokens +
  entry.cacheWrite1hTokens +
  entry.cacheReadTokens;

const usageOf = (charges: { nodeId: string; event: RunEvent }[], nodeId: string) =>
  charges.flatMap(({ nodeId: id, event }) =>
    id === nodeId && event.kind === "usage" ? [event] : [],
  );

describe("chargeUsage", () => {
  it("gives each message to the turn open before it, and the node figures add up to the transcript's cost", async () => {
    const entries = await fixtureEntries();

    const charges = chargeUsage({ events: twoTurns, entries, turnNodes });

    const [p1] = usageOf(charges, "p1");
    const [p2] = usageOf(charges, "p2");
    expect(charges.map(({ nodeId }) => nodeId)).toEqual(["p1", "p2"]);
    expect(p1?.payload.messages).toEqual(["msg_a", "msg_b", "msg_late"]);
    expect(p2?.payload.messages).toEqual(["msg_c", "msg_d"]);
    expect((p1?.cost ?? 0) + (p2?.cost ?? 0)).toBeCloseTo(costOf(entries), 12);
    expect((p1?.cost ?? 0) > 0 && (p2?.cost ?? 0) > (p1?.cost ?? 0)).toBe(true);
    const unique = [...new Map(entries.map((entry) => [entry.messageId, entry])).values()];
    expect((p1?.tokens ?? 0) + (p2?.tokens ?? 0)).toBe(
      unique.reduce((sum, entry) => sum + tokensOf(entry), 0),
    );
  });

  it("counts the last copy of a message written more than once", async () => {
    const entries = await fixtureEntries();

    const [p1] = usageOf(chargeUsage({ events: twoTurns, entries, turnNodes }), "p1");

    expect(p1?.tokens).toBe(10 + 40 + 2000 + (3 + 120 + 500 + 2050) + (1 + 2));
  });

  it("charges nothing twice: a message already in a usage event is left out", async () => {
    const entries = await fixtureEntries();
    const first = chargeUsage({ events: twoTurns, entries: entries.slice(0, 3), turnNodes });
    const after = [
      ...twoTurns,
      ...first.map(({ nodeId, event }, i) => ({
        ...event,
        nodeId,
        seq: 100 + i,
        time: at(31).toISOString(),
      })),
    ];

    const second = chargeUsage({ events: after, entries, turnNodes });

    const counted = [...first, ...second].flatMap(({ event }) =>
      event.kind === "usage" ? event.payload.messages : [],
    );
    expect(counted.sort()).toEqual(["msg_a", "msg_b", "msg_c", "msg_d", "msg_late"]);
  });

  it("gives a message without a time to the last turn, and charges nothing without a turn", () => {
    const entry: UsageEntry = {
      messageId: "m",
      model: "claude-haiku-5-5",
      inputTokens: 1,
      outputTokens: 1,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
      cacheReadTokens: 0,
    };

    expect(chargeUsage({ events: twoTurns, entries: [entry], turnNodes })).toMatchObject([
      { nodeId: "p2" },
    ]);
    expect(chargeUsage({ events: twoTurns, entries: [entry], turnNodes: new Set() })).toEqual([]);
  });
});

describe("chargeUsage in a parallel section", () => {
  const usageEntry = (messageId: string, second: number, agentType?: string): UsageEntry => ({
    messageId,
    model: "claude-haiku-5-5",
    inputTokens: 100,
    outputTokens: messageId.length * 10,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    cacheReadTokens: 0,
    at: at(second).getTime(),
    ...(agentType === undefined ? {} : { agentType }),
  });

  const parallel = stored([
    [0, "f", { kind: "sent" }],
    [1, "a1", { kind: "running" }],
    [1, "a2", { kind: "running" }],
    [9, "a1", { kind: "done" }],
    [9, "a2", { kind: "done" }],
    [9, "f", { kind: "done" }],
    [10, "j", { kind: "done" }],
  ]);

  it("charges each branch its own subagent's usage, keeps the main transcript's on the Fork, and adds up to the session", () => {
    const entries = [
      usageEntry("main_1", 1),
      usageEntry("sub_a1", 3, "h:a1"),
      usageEntry("sub_a2_long", 4, "h:a2"),
      usageEntry("sub_other", 5, "Explore"),
      usageEntry("main_2", 8),
    ];

    const charges = chargeUsage({
      events: parallel,
      entries,
      turnNodes: new Set(["f"]),
      owners: usageOwners(
        { prefix: "h", nodes: [fork("f"), agent("a1"), agent("a2"), join_("j")] },
        parallel,
      ),
    });

    expect(usageOf(charges, "f")[0]?.payload.messages).toEqual(["main_1", "sub_other", "main_2"]);
    expect(usageOf(charges, "a1")[0]?.payload.messages).toEqual(["sub_a1"]);
    expect(usageOf(charges, "a2")[0]?.payload.messages).toEqual(["sub_a2_long"]);
    const report = costReport({
      nodeIds: ["f", "a1", "a2", "j"],
      events: parallel,
      pending: charges,
      now: at(20).getTime(),
    });
    const [, a1, a2] = report.nodes;
    expect(a1?.tokens).toBe(tokensOf(entries[1] as UsageEntry));
    expect(a2?.tokens).toBe(tokensOf(entries[2] as UsageEntry));
    expect(a1?.cost).toBeCloseTo(costOf([entries[1] as UsageEntry]), 12);
    expect(a2?.cost).toBeCloseTo(costOf([entries[2] as UsageEntry]), 12);
    expect(report.total.tokens).toBe(entries.reduce((sum, entry) => sum + tokensOf(entry), 0));
    expect(report.total.cost).toBeCloseTo(costOf(entries), 12);
  });

  it("gives a message to the later-started of two turns stamped at the same time, whatever their order", () => {
    const tied = stored([
      [1, "p1", { kind: "sent" }],
      [1, "p2", { kind: "sent" }],
    ]);
    const entries = [usageEntry("m", 2), usageEntry("early", 0)];
    const owners = (events: StoredEvent[]) =>
      chargeUsage({ events, entries, turnNodes: new Set(["p1", "p2"]) }).map(
        ({ nodeId, event }) => [nodeId, event.kind === "usage" ? event.payload.messages : []],
      );

    expect(owners(tied)).toEqual([
      ["p2", ["m"]],
      ["p1", ["early"]],
    ]);
    expect(owners([...tied].reverse())).toEqual(owners(tied));
  });
});

describe("chargeUsage per round", () => {
  const spend = (
    messageId: string,
    second: number | undefined,
    outputTokens: number,
    extra: Partial<UsageEntry> = {},
  ): UsageEntry => ({
    messageId,
    model: "claude-haiku-5-5",
    inputTokens: 100,
    outputTokens,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    cacheReadTokens: 0,
    ...(second === undefined ? {} : { at: at(second).getTime() }),
    ...extra,
  });

  type Row = [number, string, RunEvent];

  const loopRows = (roundTwoDone: RunEvent = { kind: "done" }): Row[] => [
    [0, "t", { kind: "sent" }],
    [2, "t", { kind: "done" }],
    [3, "L", { kind: "running" }],
    [3, "L", { kind: "round", payload: { round: 1 } }],
    [4, "b", { kind: "sent" }],
    [9, "b", { kind: "done" }],
    [10, "L", { kind: "round", payload: { round: 2 } }],
    [10, "b", { kind: "reset" }],
    [11, "b", { kind: "sent" }],
    [19, "b", roundTwoDone],
    [20, "L", { kind: "round", payload: { round: 3 } }],
    [20, "b", { kind: "reset" }],
    [21, "b", { kind: "sent" }],
    [29, "b", { kind: "done" }],
    [30, "L", { kind: "done" }],
  ];

  const loopTurns = new Set(["t", "b"]);
  const inLoop = { b: "L" };

  const top = spend("t1", 1, 5);
  const r1 = spend("r1", 5, 10);
  const r2a = spend("r2a", 12, 300);
  const r2b = spend("r2b", 15, 40);
  const r3 = spend("r3", 25, 2000);
  const everyRound = [top, r1, r2a, r2b, r3];

  const byRound = (charges: { nodeId: string; event: RunEvent }[], nodeId: string) =>
    usageOf(charges, nodeId).sort(
      (a, b) =>
        ((a.payload as { round?: number }).round ?? 0) -
        ((b.payload as { round?: number }).round ?? 0),
    );

  type RoundLine = { round: number; tokens: number; cost: number };
  const roundsIn = (line: unknown): RoundLine[] =>
    (line as { rounds?: RoundLine[] } | undefined)?.rounds ?? [];

  it("gives each round of a Loop body node its own usage event with that round's messages, and a node outside any container one with no round", () => {
    const charges = chargeUsage({
      events: stored(loopRows()),
      entries: everyRound,
      turnNodes: loopTurns,
      parents: inLoop,
    });

    const body = byRound(charges, "b");
    expect(body.map((event) => event.payload)).toEqual([
      { messages: ["r1"], round: 1 },
      { messages: ["r2a", "r2b"], round: 2 },
      { messages: ["r3"], round: 3 },
    ]);
    expect(body.map((event) => event.cost)).toEqual([
      costOf([r1]),
      costOf([r2a, r2b]),
      costOf([r3]),
    ]);
    const [outside] = usageOf(charges, "t");
    expect(outside?.payload).toEqual({ messages: ["t1"] });
    expect(outside !== undefined && "round" in outside.payload).toBe(false);
  });

  it("reports each round of a node as its own line, the rounds adding up to the node and the total counting them once", () => {
    const events = stored(loopRows());
    const charges = chargeUsage({
      events,
      entries: everyRound,
      turnNodes: loopTurns,
      parents: inLoop,
    });

    const report = costReport({
      nodeIds: ["t", "L", "b"],
      events,
      pending: charges,
      now: at(40).getTime(),
    });

    const body = report.nodes.find((line) => line.nodeId === "b");
    const rounds = roundsIn(body);
    expect(rounds.map(({ round, tokens }) => ({ round, tokens }))).toEqual([
      { round: 1, tokens: tokensOf(r1) },
      { round: 2, tokens: tokensOf(r2a) + tokensOf(r2b) },
      { round: 3, tokens: tokensOf(r3) },
    ]);
    expect(rounds[0]?.cost).toBeCloseTo(costOf([r1]), 12);
    expect(rounds[1]?.cost).toBeCloseTo(costOf([r2a, r2b]), 12);
    expect(rounds[2]?.cost).toBeCloseTo(costOf([r3]), 12);
    expect(new Set(rounds.map((line) => line.cost)).size).toBe(3);
    expect(rounds.reduce((sum, line) => sum + line.cost, 0)).toBeCloseTo(body?.cost ?? 0, 12);
    expect(rounds.reduce((sum, line) => sum + line.tokens, 0)).toBe(body?.tokens);
    expect(report.total.cost).toBeCloseTo(costOf(everyRound), 12);
    expect(report.total.tokens).toBe(everyRound.reduce((sum, entry) => sum + tokensOf(entry), 0));
  });

  it("gives a round without usage no line, never another round's cost", () => {
    const events = stored(loopRows());
    const charges = chargeUsage({
      events,
      entries: [r1, r3],
      turnNodes: loopTurns,
      parents: inLoop,
    });

    const report = costReport({ nodeIds: ["b"], events, pending: charges, now: 0 });

    const rounds = roundsIn(report.nodes[0]);
    expect(rounds.map(({ round }) => round)).toEqual([1, 3]);
    expect(rounds[0]?.cost).toBeCloseTo(costOf([r1]), 12);
    expect(rounds[1]?.cost).toBeCloseTo(costOf([r3]), 12);
  });

  it("sums a round charged in two passes, from a resume mid-round", () => {
    const rows = loopRows();
    const resumedAt = rows.findIndex(([second, nodeId]) => nodeId === "b" && second === 11) + 1;
    const firstEvents = stored(rows.slice(0, resumedAt));
    const first = chargeUsage({
      events: firstEvents,
      entries: [top, r1, r2a],
      turnNodes: loopTurns,
      parents: inLoop,
    });
    const events = stored([
      ...rows.slice(0, resumedAt),
      ...first.map(({ nodeId, event }): Row => [13, nodeId, event]),
      ...rows.slice(resumedAt),
    ]);

    const second = chargeUsage({
      events,
      entries: everyRound,
      turnNodes: loopTurns,
      parents: inLoop,
    });

    const roundTwoEvents = [...usageOf(first, "b"), ...usageOf(second, "b")].filter(
      (event) => (event.payload as { round?: number }).round === 2,
    );
    expect(roundTwoEvents.map((event) => event.payload.messages)).toEqual([["r2a"], ["r2b"]]);
    const report = costReport({ nodeIds: ["t", "L", "b"], events, pending: second, now: 0 });
    const roundTwo = roundsIn(report.nodes[2]).find((line) => line.round === 2);
    expect(roundTwo?.tokens).toBe(tokensOf(r2a) + tokensOf(r2b));
    expect(roundTwo?.cost).toBeCloseTo(costOf([r2a, r2b]), 12);
    expect(report.total.cost).toBeCloseTo(costOf(everyRound), 12);
  });

  it("gives a subagent's usage the round of its owner's done event when owned by call, the round of its time when owned by type, and the last round when it has no time", () => {
    const events = stored(loopRows({ kind: "done", payload: { toolUseIds: ["toolu_2"] } }));
    const byCall = spend("sub_call", undefined, 70, { toolUseId: "toolu_2" });
    const byType = spend("sub_type", 6, 80, { agentType: "h:b" });
    const untimed = spend("untimed", undefined, 90);

    const charges = chargeUsage({
      events,
      entries: [byCall, byType, untimed],
      turnNodes: loopTurns,
      owners: usageOwners(
        { prefix: "h", nodes: [agent("t"), { id: "L", type: "loop" }, agent("b")] },
        events,
      ),
      parents: inLoop,
    });

    expect(byRound(charges, "b").map((event) => event.payload)).toEqual([
      { messages: ["sub_type"], round: 1 },
      { messages: ["sub_call"], round: 2 },
      { messages: ["untimed"], round: 3 },
    ]);
  });

  it("gives an old run's usage, recorded with no round, no round lines and the same node and run totals as the same usage charged per round", () => {
    const rows = loopRows();
    const perRound = chargeUsage({
      events: stored(rows),
      entries: everyRound,
      turnNodes: loopTurns,
      parents: inLoop,
    });
    const oldRun = stored([
      ...rows,
      [
        31,
        "t",
        {
          kind: "usage",
          payload: { messages: ["t1"] },
          tokens: tokensOf(top),
          cost: costOf([top]),
        },
      ],
      [
        31,
        "b",
        {
          kind: "usage",
          payload: { messages: ["r1", "r2a", "r2b", "r3"] },
          tokens: [r1, r2a, r2b, r3].reduce((sum, entry) => sum + tokensOf(entry), 0),
          cost: costOf([r1, r2a, r2b, r3]),
        },
      ],
    ]);
    const newRun = stored([
      ...rows,
      ...perRound.map(({ nodeId, event }): Row => [31, nodeId, event]),
    ]);
    const nodeIds = ["t", "L", "b"];

    const before = costReport({ nodeIds, events: oldRun, pending: [], now: 0 });
    const after = costReport({ nodeIds, events: newRun, pending: [], now: 0 });

    expect(before.nodes.map(roundsIn)).toEqual([[], [], []]);
    expect(roundsIn(after.nodes[2]).map(({ round }) => round)).toEqual([1, 2, 3]);
    before.nodes.forEach((line, index) => {
      expect(line.tokens).toBe(after.nodes[index]?.tokens);
      expect(line.cost).toBeCloseTo(after.nodes[index]?.cost ?? Number.NaN, 12);
    });
    expect(before.total.tokens).toBe(after.total.tokens);
    expect(before.total.cost).toBeCloseTo(after.total.cost, 12);
  });

  it("keeps a node's round lines through the report schema", () => {
    const report = {
      nodes: [
        {
          nodeId: "b",
          tokens: 30,
          cost: 0.3,
          ms: 1000,
          rounds: [
            { round: 1, tokens: 10, cost: 0.1 },
            { round: 2, tokens: 20, cost: 0.2 },
          ],
        },
      ],
      total: { tokens: 30, cost: 0.3, ms: 1000 },
    };

    expect(costReportSchema.parse(report)).toEqual(report);
  });
});

describe("usageOwners", () => {
  it("names each agent node by the build's prefix and its node id when the build named no pieces", () => {
    expect(usageOwners({ prefix: "fix-login", nodes: [fork("f"), agent("a1")] }, []).types).toEqual(
      new Map([["fix-login:a1", "a1"]]),
    );
  });

  it("names a hash-named build's agents by its hash, its prefix", () => {
    expect(usageOwners({ prefix: "abc123", nodes: [agent("a1")] }, []).types).toEqual(
      new Map([["abc123:a1", "a1"]]),
    );
  });

  it("names an agent by its piece, and leaves out a piece two nodes share", () => {
    const owners = usageOwners(
      { prefix: "h", nodes: [agent("a1", "review"), agent("a2", "review"), agent("a3", "plan")] },
      [],
    );

    expect(owners.types).toEqual(new Map([["h:plan", "a3"]]));
  });

  it("maps each call id on a node's done event to that node", () => {
    const events = stored([
      [1, "a1", { kind: "sent" }],
      [5, "a1", { kind: "done", payload: { toolUseIds: ["toolu_1"] } }],
      [6, "a2", { kind: "sent" }],
      [9, "a2", { kind: "done", payload: { stopMessage: "ok", toolUseIds: ["toolu_2"] } }],
    ]);

    expect(
      usageOwners({ prefix: "h", nodes: [agent("a1", "review"), agent("a2", "review")] }, events)
        .calls,
    ).toEqual(
      new Map([
        ["toolu_1", "a1"],
        ["toolu_2", "a2"],
      ]),
    );
  });
});

describe("chargeUsage for nodes that share a piece", () => {
  const subEntry = (messageId: string, second: number, toolUseId?: string): UsageEntry => ({
    messageId,
    model: "claude-haiku-5-5",
    inputTokens: 100,
    outputTokens: 10,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    cacheReadTokens: 0,
    at: at(second).getTime(),
    agentType: "h:review",
    ...(toolUseId === undefined ? {} : { toolUseId }),
  });
  const shared = { prefix: "h", nodes: [agent("a1", "review"), agent("a2", "review")] };

  it("charges each node only the usage of the calls its done event lists", () => {
    const parallel = stored([
      [0, "a1", { kind: "sent" }],
      [0, "a2", { kind: "sent" }],
      [9, "a2", { kind: "done", payload: { toolUseIds: ["toolu_2"] } }],
      [9, "a1", { kind: "done", payload: { toolUseIds: ["toolu_1"] } }],
    ]);
    const entries = [subEntry("sub_1", 2, "toolu_1"), subEntry("sub_2", 3, "toolu_2")];

    const charges = chargeUsage({
      events: parallel,
      entries,
      turnNodes: new Set(["a1", "a2"]),
      owners: usageOwners(shared, parallel),
    });

    expect(usageOf(charges, "a1")[0]?.payload.messages).toEqual(["sub_1"]);
    expect(usageOf(charges, "a2")[0]?.payload.messages).toEqual(["sub_2"]);
  });
});

describe("costReport", () => {
  it("adds each node's tokens, cost and time, and a session line that is their sum", async () => {
    const entries = await fixtureEntries();
    const charges = chargeUsage({ events: twoTurns, entries, turnNodes });

    const report = costReport({
      nodeIds: ["t", "p1", "s1", "p2"],
      events: twoTurns,
      pending: charges,
      now: at(40).getTime(),
    });

    const p1 = usageOf(charges, "p1")[0];
    const p2 = usageOf(charges, "p2")[0];
    expect(report.nodes).toEqual([
      { nodeId: "t", tokens: 0, cost: 0, ms: 0 },
      { nodeId: "p1", tokens: p1?.tokens, cost: p1?.cost, ms: 9000 },
      { nodeId: "s1", tokens: 0, cost: 0, ms: 1000 },
      { nodeId: "p2", tokens: p2?.tokens, cost: p2?.cost, ms: 10000 },
    ]);
    expect(report.total.cost).toBeCloseTo(
      report.nodes.reduce((sum, line) => sum + line.cost, 0),
      12,
    );
    expect(report.total.tokens).toBe(report.nodes.reduce((sum, line) => sum + line.tokens, 0));
    expect(report.total.ms).toBe(30000);
  });

  it("reads stored usage events, and times a node still in its turn up to now", () => {
    const events = stored([
      [0, "p1", { kind: "sent" }],
      [1, "p1", { kind: "usage", payload: { messages: ["m"] }, tokens: 5, cost: 0.5 }],
    ]);

    const report = costReport({ nodeIds: ["p1", "p2"], events, pending: [], now: at(4).getTime() });

    expect(report.nodes).toEqual([
      { nodeId: "p1", tokens: 5, cost: 0.5, ms: 4000 },
      { nodeId: "p2", tokens: 0, cost: 0, ms: null },
    ]);
    expect(report.total).toEqual({ tokens: 5, cost: 0.5, ms: 4000 });
  });
});
