import type { ManifestContainer, ManifestNode } from "../compiler/lower.js";
import { agentCallOf, type AgentCallEvent } from "./agent-calls.js";
import { hasFinishedPath } from "./finished-path.js";
import type { PipelineItem, PipelineStage } from "./pipeline.js";
import { nodeStatus, type RunEvent } from "./run-events.js";
import type { EventEntry, StoredEvent } from "./store.js";
import { turnFailure } from "./turns.js";

export type WatchedContainer = {
  prefix: string;
  nodes: readonly Pick<ManifestNode, "id" | "type" | "label" | "parent">[];
  wires: ManifestContainer["wires"];
};

export type SessionWatchDeps = { container: WatchedContainer; sessionId: string };

export type SessionHookEvent = AgentCallEvent & { sessionId: string };

export type SessionFailure = { container: string; node: string };

export class SessionWatch {
  started = false;
  private stopped = false;
  private open: string | undefined;
  private readonly finished = new Set<string>();

  constructor(private readonly deps: SessionWatchDeps) {}

  accept(event: SessionHookEvent): EventEntry[] {
    if (event.sessionId !== this.deps.sessionId || this.stopped) return [];
    const entries = this.start();
    switch (event.kind) {
      case "PreToolUse":
        return [...entries, ...this.onCall(event)];
      case "PostToolUse":
        return [...entries, ...this.onResult(event)];
      case "Stop":
        return [...entries, ...this.onStop()];
      case "StopFailure":
        return [...entries, ...this.fail(turnFailure(event).message)];
      default:
        return entries;
    }
  }

  seed(history: readonly StoredEvent[]): void {
    for (const node of this.deps.container.nodes) {
      const status = nodeStatus(history.filter((event) => event.nodeId === node.id));
      if (status === "waiting") continue;
      this.started = true;
      if (status === "done") this.finished.add(node.id);
      if (status === "failed" || (status === "done" && node.type === "output")) this.stopped = true;
      if (status === "running" || status === "needs-you") this.open = node.id;
    }
  }

  get openNode(): string | undefined {
    return this.open;
  }

  died(): EventEntry[] {
    return this.fail(`session ${this.deps.sessionId} ended before its Stop`);
  }

  private get startNode() {
    return this.deps.container.nodes.find((node) => node.type === "trigger");
  }

  private get stopNode() {
    return this.deps.container.nodes.find((node) => node.type === "output");
  }

  private start(): EventEntry[] {
    if (this.started) return [];
    this.started = true;
    const start = this.startNode;
    return start === undefined ? [] : this.finish(start.id);
  }

  private ownNode(event: SessionHookEvent): string | undefined {
    const kind = event.kind === "PreToolUse" ? "PreToolUse" : "PostToolUse";
    const nodeId = agentCallOf({ kind, payload: event.payload })?.nodeId;
    return nodeId !== undefined && this.deps.container.nodes.some((node) => node.id === nodeId)
      ? nodeId
      : undefined;
  }

  private onCall(event: SessionHookEvent): EventEntry[] {
    const nodeId = this.ownNode(event);
    if (nodeId === undefined || this.finished.has(nodeId) || this.open === nodeId) return [];
    this.open = nodeId;
    return [{ nodeId, event: { kind: "running" } }];
  }

  private onResult(event: SessionHookEvent): EventEntry[] {
    const nodeId = this.ownNode(event);
    if (nodeId === undefined || this.finished.has(nodeId)) return [];
    const opening: EventEntry[] =
      this.open === nodeId ? [] : [{ nodeId, event: { kind: "running" } }];
    this.open = undefined;
    this.finished.add(nodeId);
    return [...opening, { nodeId, event: { kind: "done" } }];
  }

  private onStop(): EventEntry[] {
    const stop = this.stopNode;
    if (stop === undefined || this.open !== undefined) return [];
    if (!hasFinishedPath(this.deps.container, this.finished)) return [];
    this.stopped = true;
    return this.finish(stop.id);
  }

  private finish(nodeId: string): EventEntry[] {
    this.finished.add(nodeId);
    return [
      { nodeId, event: { kind: "running" } },
      { nodeId, event: { kind: "done" } },
    ];
  }

  failAt(nodeId: string, message: string): EventEntry[] {
    if (this.stopped) return [];
    this.stopped = true;
    const failed: RunEvent = { kind: "failed", payload: { message } };
    const opening: EventEntry[] =
      this.open === nodeId ? [] : [{ nodeId, event: { kind: "running" } }];
    this.open = undefined;
    return [...opening, { nodeId, event: failed }];
  }

  fail(message: string): EventEntry[] {
    const nodeId = this.open ?? this.stopNode?.id;
    return nodeId === undefined ? [] : this.failAt(nodeId, message);
  }
}

const stagesOf = (items: readonly PipelineItem[]): PipelineStage[] =>
  items.flatMap((item) =>
    "lanes" in item
      ? item.lanes.flatMap(stagesOf)
      : [item, ...(item.rounds ?? []).flatMap((round) => stagesOf(round.items))],
  );

export function sessionFailureOf(
  groups: readonly { name: string; items: readonly PipelineItem[] }[],
): SessionFailure | undefined {
  for (const group of groups.slice(1)) {
    const failed = stagesOf(group.items).find((stage) => stage.status === "failed");
    if (failed !== undefined) return { container: group.name, node: failed.label };
  }
  return undefined;
}
