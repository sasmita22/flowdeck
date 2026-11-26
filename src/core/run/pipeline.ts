import { z } from "zod";
import { NodeType, type Wire } from "../flow/schema.js";
import { order } from "../flow/order.js";
import { activityEntrySchema, type ActivityEntry } from "./activity.js";
import type { CostReport } from "./cost.js";
import { plainReason } from "./failure.js";
import type { DisplayStatus } from "./display.js";
import { sessionOverlayOf } from "./finished-path.js";
import type { StageGroup, StageNode } from "./manifest.js";
import { decisionsOf, donePayload, nodeStatus, roundItems, type RunEvent } from "./run-events.js";
import { nodeStateSchema, type SnapshotStatus } from "./snapshot.js";
import type { NodeState } from "./state.js";
import type { StoredEvent } from "./store.js";
import type { HumanDecision } from "./wait.js";

export type TimelineEvent = {
  nodeId: string;
  seq: number;
  time: string;
  kind: RunEvent["kind"];
  payload?: unknown;
  tokens?: number | undefined;
  cost?: number | undefined;
};

export type PipelineStage = {
  nodeId: string;
  type: NodeType;
  label: string;
  status: NodeState;
  startedAt?: number | undefined;
  finishedAt?: number | undefined;
  ms?: number | undefined;
  retries: number;
  tokens?: number | undefined;
  cost?: number | undefined;
  reason?: string | undefined;
  decisions: HumanDecision[];
  reply?: string | undefined;
  timeline: TimelineEvent[];
  activity: ActivityEntry[];
  activityFrom?: number | undefined;
  activityTo?: number | undefined;
  rounds?: PipelineRound[] | undefined;
};

type PipelineRound = {
  round: number;
  item?: string | undefined;
  tokens?: number | undefined;
  cost?: number | undefined;
  items: PipelineItem[];
};

type ParallelGroup = { lanes: PipelineItem[][] };

export type PipelineItem = PipelineStage | ParallelGroup;

export type ContainerStatus = Extract<
  DisplayStatus,
  "waiting" | "not-started" | "running" | "done" | "stopped" | "failed"
>;

export type PipelineGroup = { name: string; status: ContainerStatus; items: PipelineItem[] };

const runEventKind = z.enum([
  "sent",
  "running",
  "retry",
  "needs-you",
  "skipped",
  "reset",
  "done",
  "failed",
  "decided",
  "answered",
  "round",
  "usage",
  "compacted",
]) satisfies z.ZodType<RunEvent["kind"]>;

const timelineEventSchema = z.object({
  nodeId: z.string(),
  seq: z.number(),
  time: z.string(),
  kind: runEventKind,
  payload: z.unknown().optional(),
  tokens: z.number().optional(),
  cost: z.number().optional(),
});

const humanDecisionSchema = z.union([
  z.object({ nodeId: z.string(), decision: z.enum(["approved", "skipped", "continued"]) }),
  z.object({ nodeId: z.string(), decision: z.enum(["rejected", "stopped"]), reason: z.string() }),
  z.object({ nodeId: z.string(), decision: z.literal("answered"), answer: z.string() }),
]);

const stageSchema = z.object({
  nodeId: z.string(),
  type: NodeType,
  label: z.string(),
  status: nodeStateSchema,
  startedAt: z.number().optional(),
  finishedAt: z.number().optional(),
  ms: z.number().optional(),
  retries: z.number().int(),
  tokens: z.number().optional(),
  cost: z.number().optional(),
  reason: z.string().optional(),
  decisions: z.array(humanDecisionSchema),
  reply: z.string().optional(),
  timeline: z.array(timelineEventSchema),
  activity: z.array(activityEntrySchema),
  activityFrom: z.number().optional(),
  activityTo: z.number().optional(),
  get rounds() {
    return z.array(roundSchema).optional();
  },
});

const roundSchema = z.object({
  round: z.number().int(),
  item: z.string().optional(),
  tokens: z.number().optional(),
  cost: z.number().optional(),
  get items() {
    return z.array(pipelineItemSchema);
  },
});

const parallelGroupSchema = z.object({
  get lanes() {
    return z.array(z.array(pipelineItemSchema));
  },
});

export const pipelineItemSchema: z.ZodType<PipelineItem> = z.lazy(() =>
  z.union([stageSchema, parallelGroupSchema]),
);

type Window = {
  fromSeq: number;
  toSeq: number;
  fromAt: number;
  toAt: number;
  whole: boolean;
  round?: number;
};

const wholeRun: Window = {
  fromSeq: -Infinity,
  toSeq: Infinity,
  fromAt: -Infinity,
  toAt: Infinity,
  whole: true,
};

export const stageActivityOf = (
  entries: readonly ActivityEntry[],
  stage: Pick<PipelineStage, "nodeId" | "activityFrom" | "activityTo">,
): ActivityEntry[] =>
  entries.filter(
    (entry) =>
      entry.nodeId === stage.nodeId &&
      (stage.activityFrom === undefined || entry.at > stage.activityFrom) &&
      (stage.activityTo === undefined || entry.at <= stage.activityTo),
  );

const startKinds = new Set<RunEvent["kind"]>(["sent", "running"]);
const endKinds = new Set<RunEvent["kind"]>(["done", "failed", "skipped"]);
const finishedStates = new Set<NodeState>(["done", "failed", "skipped"]);

const timeOf = (event: StoredEvent) => Date.parse(event.time);

const stagesIn = (items: readonly PipelineItem[]): PipelineStage[] =>
  items.flatMap((item) => ("lanes" in item ? item.lanes.flatMap(stagesIn) : [item]));

const grouped = <T extends { nodeId: string }>(entries: readonly T[]): Map<string, T[]> => {
  const byNode = new Map<string, T[]>();
  for (const entry of entries)
    byNode.set(entry.nodeId, [...(byNode.get(entry.nodeId) ?? []), entry]);
  return byNode;
};

export function pipelineOf(
  groups: readonly StageGroup[],
  events: readonly StoredEvent[],
  activity: readonly ActivityEntry[],
  cost: CostReport,
  runStatus: SnapshotStatus,
  sessionStates: Readonly<Record<string, NodeState>> = sessionOverlayOf(groups.slice(1), events),
): PipelineGroup[] {
  const eventsOf = grouped([...events].sort((a, b) => a.seq - b.seq));
  return groups.map((group) => ({
    name: group.name,
    status: containerStatusOf(group.nodes, eventsOf, runStatus),
    items: itemsOfGroup(group.nodes, group.wires, events, activity, cost, sessionStates),
  }));
}

function containerStatusOf(
  nodes: readonly StageNode[],
  eventsOf: ReadonlyMap<string, readonly StoredEvent[]>,
  runStatus: SnapshotStatus,
): ContainerStatus {
  const states = nodes.map((node) => ({ node, status: nodeStatus(eventsOf.get(node.id) ?? []) }));
  if (states.some(({ status }) => status === "failed")) return "failed";
  if (states.some(({ node, status }) => node.type === "output" && status === "done")) return "done";
  const running = runStatus === "running";
  if (states.every(({ status }) => status === "waiting"))
    return running ? "waiting" : "not-started";
  return running ? "running" : "stopped";
}

function itemsOfGroup(
  nodes: readonly StageNode[],
  wires: readonly Wire[],
  events: readonly StoredEvent[],
  activity: readonly ActivityEntry[],
  cost: CostReport,
  sessionStates: Readonly<Record<string, NodeState>>,
): PipelineItem[] {
  const ids = order({ nodes, wires });
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const scopeOf = (id: string) => {
    const parent = byId.get(id)?.parent;
    return parent !== undefined && byId.has(parent) ? parent : undefined;
  };
  const eventsOf = grouped([...events].sort((a, b) => a.seq - b.seq));
  const activityOf = grouped(activity);
  const costOf = new Map(cost.nodes.map((line) => [line.nodeId, line]));
  const thenWires = wires.filter((wire) => wire.kind === "then");
  const successors = (id: string) => [
    ...new Set(thenWires.filter((wire) => wire.from.node === id).map((wire) => wire.to.node)),
  ];

  const stageOf = (node: StageNode, window: Window): PipelineStage => {
    const history = (eventsOf.get(node.id) ?? []).filter((event) => event.seq < window.toSeq);
    const own = history.filter((event) => event.seq >= window.fromSeq);
    const raw = nodeStatus(history);
    const status = raw === "waiting" ? (sessionStates[node.id] ?? raw) : raw;
    const started = own.find((event) => startKinds.has(event.kind));
    const finished = finishedStates.has(status)
      ? own.findLast((event) => endKinds.has(event.kind))
      : undefined;
    const startedAt = started === undefined ? undefined : timeOf(started);
    const finishedAt = finished === undefined ? undefined : timeOf(finished);
    const usage = own.flatMap((event) => (event.kind === "usage" ? [event] : []));
    const line = window.whole ? costOf.get(node.id) : undefined;
    const roundLine = window.whole
      ? undefined
      : costOf.get(node.id)?.rounds?.find((each) => each.round === window.round);
    const failed =
      status === "failed" ? own.findLast((event) => event.kind === "failed") : undefined;
    const done = own.findLast((event) => event.kind === "done");
    const reply =
      done?.kind === "done"
        ? donePayload.safeParse(done.payload ?? {}).data?.stopMessage
        : undefined;
    const rounds =
      node.type === "loop" || node.type === "foreach" ? roundsOf(node.id, window) : undefined;
    const edges = {
      ...(Number.isFinite(window.fromAt) ? { activityFrom: window.fromAt } : {}),
      ...(Number.isFinite(window.toAt) ? { activityTo: window.toAt } : {}),
    };
    return {
      nodeId: node.id,
      type: node.type,
      label: node.label,
      status,
      ...(startedAt === undefined ? {} : { startedAt }),
      ...(finishedAt === undefined ? {} : { finishedAt }),
      ...(startedAt === undefined || finishedAt === undefined
        ? {}
        : { ms: finishedAt - startedAt }),
      retries: own.filter((event) => event.kind === "retry").length,
      ...(window.whole
        ? {
            tokens: line?.tokens ?? usage.reduce((sum, event) => sum + event.tokens, 0),
            cost: line?.cost ?? usage.reduce((sum, event) => sum + event.cost, 0),
          }
        : roundLine === undefined
          ? {}
          : { tokens: roundLine.tokens, cost: roundLine.cost }),
      ...(failed?.kind === "failed"
        ? { reason: plainReason(node.id, failed.payload.message) }
        : {}),
      decisions: decisionsOf(own),
      ...(reply === undefined ? {} : { reply }),
      timeline: window.whole ? own : own.filter((event) => event.kind !== "usage"),
      activity: stageActivityOf(activityOf.get(node.id) ?? [], { nodeId: node.id, ...edges }),
      ...edges,
      ...(rounds === undefined ? {} : { rounds }),
    };
  };

  const roundsOf = (loopId: string, window: Window): PipelineRound[] => {
    const loopEvents = eventsOf.get(loopId) ?? [];
    const marks: { round: number; seq: number; at: number }[] = [];
    for (const event of loopEvents) {
      if (event.kind !== "round" || event.seq < window.fromSeq || event.seq >= window.toSeq)
        continue;
      if (marks.some((mark) => mark.round === event.payload.round)) continue;
      marks.push({ round: event.payload.round, seq: event.seq, at: timeOf(event) });
    }
    if (marks.length === 0) marks.push({ round: 1, seq: window.fromSeq, at: window.fromAt });
    const children = ids.filter((id) => scopeOf(id) === loopId);
    const labels = roundItems(loopEvents);
    return marks.map((mark, index) => {
      const next = marks[index + 1];
      const first = index === 0;
      const item = labels?.[mark.round - 1];
      const items = itemsOf(children, {
        fromSeq: first ? window.fromSeq : mark.seq,
        toSeq: next?.seq ?? window.toSeq,
        fromAt: first ? window.fromAt : mark.at,
        toAt: next?.at ?? window.toAt,
        whole: false,
        round: mark.round,
      });
      const priced = stagesIn(items).filter((stage) => stage.cost !== undefined);
      return {
        round: mark.round,
        ...(item === undefined ? {} : { item }),
        ...(priced.length === 0
          ? {}
          : {
              tokens: priced.reduce((sum, stage) => sum + (stage.tokens ?? 0), 0),
              cost: priced.reduce((sum, stage) => sum + (stage.cost ?? 0), 0),
            }),
        items,
      };
    });
  };

  const itemsOf = (scopeIds: readonly string[], window: Window): PipelineItem[] => {
    const position = new Map(scopeIds.map((id, index) => [id, index]));
    const taken = new Set<string>();
    const laneFrom = (first: string): string[] => {
      const lane: string[] = [];
      let at: string | undefined = first;
      while (
        at !== undefined &&
        position.has(at) &&
        !taken.has(at) &&
        !lane.includes(at) &&
        byId.get(at)?.type !== "join"
      ) {
        lane.push(at);
        const next: string[] = successors(at).filter((id) => position.has(id));
        at = next.length === 1 ? next[0] : undefined;
      }
      return lane;
    };
    const items: PipelineItem[] = [];
    for (const id of scopeIds) {
      const node = byId.get(id);
      if (node === undefined || taken.has(id)) continue;
      items.push(stageOf(node, window));
      if (node.type !== "fork") continue;
      const starts = successors(id)
        .filter((next) => position.has(next))
        .sort((a, b) => (position.get(a) ?? 0) - (position.get(b) ?? 0));
      const lanes = starts.map(laneFrom).filter((lane) => lane.length > 0);
      for (const lane of lanes) for (const member of lane) taken.add(member);
      if (lanes.length > 0) items.push({ lanes: lanes.map((lane) => itemsOf(lane, window)) });
    }
    return items;
  };

  return itemsOf(
    ids.filter((id) => scopeOf(id) === undefined),
    wholeRun,
  );
}
