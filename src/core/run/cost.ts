import { z } from "zod";
import { agentType } from "../nodes/agent/execute.js";
import { costOf, type UsageEntry } from "./budget.js";
import { nodeStatus, type RunEvent } from "./run-events.js";
import type { EventEntry, StoredEvent } from "./store.js";

export type CostLine = { nodeId: string; tokens: number; cost: number; ms: number | null };

export type CostReport = { nodes: CostLine[]; total: { tokens: number; cost: number; ms: number } };

const costLineSchema = z.object({
  nodeId: z.string(),
  tokens: z.number(),
  cost: z.number(),
  ms: z.number().nullable(),
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

type TurnStart = { nodeId: string; at: number; seq: number };

function turnStarts(events: readonly TimedEvent[], turnNodes: ReadonlySet<string>): TurnStart[] {
  return events
    .filter((event) => turnNodes.has(event.nodeId) && startKinds.has(event.kind))
    .map((event) => ({ nodeId: event.nodeId, at: Date.parse(event.time), seq: event.seq }))
    .sort((a, b) => a.at - b.at || a.seq - b.seq);
}

function ownerOf(starts: readonly TurnStart[], at: number | undefined): string | undefined {
  if (at === undefined) return starts.at(-1)?.nodeId;
  return (starts.findLast((start) => start.at <= at) ?? starts[0])?.nodeId;
}

export const agentNodes = (manifest: {
  hash: string;
  nodes: readonly { id: string; type: string }[];
}): Map<string, string> =>
  new Map(
    manifest.nodes
      .filter((node) => node.type === "agent")
      .map((node) => [agentType(manifest.hash, node.id), node.id]),
  );

export function chargeUsage(input: {
  events: readonly TimedEvent[];
  entries: readonly UsageEntry[];
  turnNodes: ReadonlySet<string>;
  agentNodes?: ReadonlyMap<string, string>;
}): EventEntry[] {
  const counted = countedMessages(input.events);
  const starts = turnStarts(input.events, input.turnNodes);
  const latest = new Map(input.entries.map((entry) => [entry.messageId, entry]));
  const byNode = new Map<string, UsageEntry[]>();
  for (const entry of latest.values()) {
    if (counted.has(entry.messageId)) continue;
    const branch =
      entry.agentType === undefined ? undefined : input.agentNodes?.get(entry.agentType);
    const nodeId = branch ?? ownerOf(starts, entry.at);
    if (nodeId === undefined) continue;
    byNode.set(nodeId, [...(byNode.get(nodeId) ?? []), entry]);
  }
  return [...byNode].map(([nodeId, entries]) => ({
    nodeId,
    event: {
      kind: "usage",
      payload: { messages: entries.map((entry) => entry.messageId) },
      tokens: entries.reduce((sum, entry) => sum + tokensOf(entry), 0),
      cost: costOf(entries),
    },
  }));
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
    return {
      nodeId,
      tokens: own.reduce((sum, event) => sum + event.tokens, 0),
      cost: own.reduce((sum, event) => sum + event.cost, 0),
      ms: timeOf(
        input.events.filter((event) => event.nodeId === nodeId),
        input.now,
      ),
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
