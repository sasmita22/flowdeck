import { z } from "zod";
import { pieceOf } from "../compiler/pieces.js";
import { agentType } from "../nodes/agent/execute.js";
import { costOf, type UsageEntry } from "./budget.js";
import { donePayload, nodeStatus, type RunEvent } from "./run-events.js";
import type { EventEntry, StoredEvent } from "./store.js";

type RoundLine = { round: number; tokens: number; cost: number };

type CostLine = {
  nodeId: string;
  tokens: number;
  cost: number;
  ms: number | null;
  rounds?: RoundLine[] | undefined;
};

export type CostReport = { nodes: CostLine[]; total: { tokens: number; cost: number; ms: number } };

const costLineSchema = z.object({
  nodeId: z.string(),
  tokens: z.number(),
  cost: z.number(),
  ms: z.number().nullable(),
  rounds: z.array(z.object({ round: z.number(), tokens: z.number(), cost: z.number() })).optional(),
});

export const costReportSchema = z.object({
  nodes: z.array(costLineSchema),
  total: z.object({ tokens: z.number(), cost: z.number(), ms: z.number() }),
});

type TimedEvent = Pick<StoredEvent, "nodeId" | "seq" | "time"> & RunEvent;

const tokensOf = (entry: UsageEntry) =>
  entry.inputTokens +
  entry.outputTokens +
  entry.cacheWrite5mTokens +
  entry.cacheWrite1hTokens +
  entry.cacheReadTokens;

const startKinds = new Set<RunEvent["kind"]>(["sent", "running"]);
const endKinds = new Set<RunEvent["kind"]>(["done", "failed", "skipped"]);

function countedMessages(events: readonly TimedEvent[]): Set<string> {
  return new Set(events.flatMap((event) => (event.kind === "usage" ? event.payload.messages : [])));
}

type Mark = { at: number; seq: number };

type TurnStart = Mark & { nodeId: string };

type RoundMark = Mark & { round: number };

const markOf = (event: TimedEvent): Mark => ({ at: Date.parse(event.time), seq: event.seq });

const byMark = (a: Mark, b: Mark) => a.at - b.at || a.seq - b.seq;

function turnStarts(events: readonly TimedEvent[], turnNodes: ReadonlySet<string>): TurnStart[] {
  return events
    .filter((event) => turnNodes.has(event.nodeId) && startKinds.has(event.kind))
    .map((event) => ({ nodeId: event.nodeId, ...markOf(event) }))
    .sort(byMark);
}

function owningStart(starts: readonly TurnStart[], at: number | undefined): TurnStart | undefined {
  if (at === undefined) return starts.at(-1);
  return starts.findLast((start) => start.at <= at) ?? starts[0];
}

function roundMarks(events: readonly TimedEvent[]): Map<string, RoundMark[]> {
  const marks = new Map<string, RoundMark[]>();
  for (const event of events) {
    if (event.kind !== "round") continue;
    const mark = { ...markOf(event), round: event.payload.round };
    marks.set(event.nodeId, [...(marks.get(event.nodeId) ?? []), mark]);
  }
  for (const list of marks.values()) list.sort(byMark);
  return marks;
}

function doneMarks(events: readonly TimedEvent[]): Map<string, Mark> {
  const marks = new Map<string, Mark>();
  for (const event of events) {
    if (event.kind !== "done") continue;
    const parsed = donePayload.safeParse(event.payload ?? {});
    for (const id of parsed.success ? (parsed.data.toolUseIds ?? []) : []) {
      marks.set(id, markOf(event));
    }
  }
  return marks;
}

function roundAt(marks: readonly RoundMark[], when: Mark | number | undefined): number | undefined {
  if (when === undefined) return marks.at(-1)?.round;
  if (typeof when === "number") return marks.findLast((mark) => mark.at <= when)?.round;
  return marks.findLast((mark) => byMark(mark, when) < 0)?.round;
}

type UsageOwners = {
  calls: ReadonlyMap<string, string>;
  types: ReadonlyMap<string, string>;
};

type OwnedEvent = { nodeId: string; kind: string; payload?: unknown };

export function usageOwners(
  manifest: { prefix: string; nodes: readonly { id: string; type: string; piece?: string }[] },
  events: readonly OwnedEvent[],
): UsageOwners {
  const calls = new Map<string, string>();
  for (const event of events) {
    if (event.kind !== "done") continue;
    const parsed = donePayload.safeParse(event.payload ?? {});
    for (const id of parsed.success ? (parsed.data.toolUseIds ?? []) : []) {
      calls.set(id, event.nodeId);
    }
  }
  const byType = new Map<string, string[]>();
  for (const node of manifest.nodes.filter((candidate) => candidate.type === "agent")) {
    const type = agentType(manifest.prefix, pieceOf(node));
    byType.set(type, [...(byType.get(type) ?? []), node.id]);
  }
  const types = new Map(
    [...byType].flatMap(([type, [only, ...others]]) =>
      only !== undefined && others.length === 0 ? [[type, only] as const] : [],
    ),
  );
  return { calls, types };
}

export function chargeUsage(input: {
  events: readonly TimedEvent[];
  entries: readonly UsageEntry[];
  turnNodes: ReadonlySet<string>;
  owners?: UsageOwners;
  parents?: Readonly<Record<string, string>>;
}): EventEntry[] {
  const counted = countedMessages(input.events);
  const starts = turnStarts(input.events, input.turnNodes);
  const rounds = roundMarks(input.events);
  const dones = doneMarks(input.events);
  const latest = new Map(input.entries.map((entry) => [entry.messageId, entry]));
  const charges = new Map<string, { nodeId: string; round?: number; entries: UsageEntry[] }>();
  for (const entry of latest.values()) {
    if (counted.has(entry.messageId)) continue;
    const byCall =
      entry.toolUseId === undefined ? undefined : input.owners?.calls.get(entry.toolUseId);
    const byType =
      entry.agentType === undefined ? undefined : input.owners?.types.get(entry.agentType);
    const owned = byCall ?? byType;
    const start = owned === undefined ? owningStart(starts, entry.at) : undefined;
    const nodeId = owned ?? start?.nodeId;
    if (nodeId === undefined) continue;
    const parent = input.parents?.[nodeId];
    const when =
      byCall !== undefined && entry.toolUseId !== undefined
        ? dones.get(entry.toolUseId)
        : (start ?? entry.at);
    const round = parent === undefined ? undefined : roundAt(rounds.get(parent) ?? [], when);
    const key = `${nodeId}\u0000${round ?? ""}`;
    const charge = charges.get(key) ?? {
      nodeId,
      ...(round === undefined ? {} : { round }),
      entries: [],
    };
    charge.entries.push(entry);
    charges.set(key, charge);
  }
  return [...charges.values()].map(({ nodeId, round, entries }) => ({
    nodeId,
    event: {
      kind: "usage",
      payload: {
        messages: entries.map((entry) => entry.messageId),
        ...(round === undefined ? {} : { round }),
      },
      tokens: entries.reduce((sum, entry) => sum + tokensOf(entry), 0),
      cost: costOf(entries),
    },
  }));
}

function roundLines(usage: readonly Extract<RunEvent, { kind: "usage" }>[]): RoundLine[] {
  const lines = new Map<number, RoundLine>();
  for (const event of usage) {
    const round = event.payload.round;
    if (round === undefined) continue;
    const line = lines.get(round) ?? { round, tokens: 0, cost: 0 };
    lines.set(round, { round, tokens: line.tokens + event.tokens, cost: line.cost + event.cost });
  }
  return [...lines.values()].sort((a, b) => a.round - b.round);
}

function timeOf(events: readonly TimedEvent[], now: number): number | null {
  const start = events.find((event) => startKinds.has(event.kind));
  if (start === undefined) return null;
  const from = Date.parse(start.time);
  const status = nodeStatus(events);
  if (status === "sent" || status === "running" || status === "needs-you") return now - from;
  const end = events.findLast((event) => endKinds.has(event.kind));
  return end === undefined ? null : Date.parse(end.time) - from;
}

export function costReport(input: {
  nodeIds: readonly string[];
  events: readonly TimedEvent[];
  pending: readonly EventEntry[];
  now: number;
}): CostReport {
  const usage = [
    ...input.events.flatMap((event) => (event.kind === "usage" ? [event] : [])),
    ...input.pending.flatMap(({ nodeId, event }) =>
      event.kind === "usage" ? [{ ...event, nodeId }] : [],
    ),
  ];
  const nodes = input.nodeIds.map((nodeId): CostLine => {
    const own = usage.filter((event) => event.nodeId === nodeId);
    const rounds = roundLines(own);
    return {
      nodeId,
      tokens: own.reduce((sum, event) => sum + event.tokens, 0),
      cost: own.reduce((sum, event) => sum + event.cost, 0),
      ms: timeOf(
        input.events.filter((event) => event.nodeId === nodeId),
        input.now,
      ),
      ...(rounds.length === 0 ? {} : { rounds }),
    };
  });
  const timed = nodes.flatMap((line) => {
    const events = input.events.filter((event) => event.nodeId === line.nodeId);
    const start = events.find((event) => startKinds.has(event.kind));
    return start === undefined || line.ms === null
      ? []
      : [{ from: Date.parse(start.time), to: Date.parse(start.time) + line.ms }];
  });
  const from = Math.min(...timed.map((span) => span.from));
  const to = Math.max(...timed.map((span) => span.to));
  return {
    nodes,
    total: {
      tokens: nodes.reduce((sum, line) => sum + line.tokens, 0),
      cost: nodes.reduce((sum, line) => sum + line.cost, 0),
      ms: timed.length === 0 ? 0 : to - from,
    },
  };
}
