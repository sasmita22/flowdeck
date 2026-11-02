import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TranscriptUsage } from "../../../src/adapters/claude/transcript-usage.js";
import { costOf, type UsageEntry } from "../../../src/core/run/budget.js";
import { agentNodes, chargeUsage, costReport } from "../../../src/core/run/cost.js";
import type { RunEvent } from "../../../src/core/run/run-events.js";
import type { StoredEvent } from "../../../src/core/run/store.js";

const fork = (id: string) => ({ id, type: "fork" });
const agent = (id: string) => ({ id, type: "agent" });
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
      agentNodes: agentNodes({
        hash: "h",
        nodes: [fork("f"), agent("a1"), agent("a2"), join_("j")],
      }),
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
