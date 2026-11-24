import type { ManifestContainer, ManifestNode } from "../compiler/lower.js";
import { agentCallOf, type AgentCallEvent } from "./agent-calls.js";
import { hasFinishedPath } from "./finished-path.js";
import type { PipelineItem, PipelineStage } from "./pipeline.js";
import { nodeStatus, type RunEvent } from "./run-events.js";
import { stoppedNodeOf, stopsTheRun } from "./stop-marker.js";
import type { EventEntry, StoredEvent } from "./store.js";
import { turnFailure } from "./turns.js";

export type WatchedContainer = {
  prefix: string;
  nodes: readonly (Pick<ManifestNode, "id" | "type" | "label" | "parent"> &
    Partial<Pick<ManifestNode, "settings">>)[];
  wires: ManifestContainer["wires"];
};

export type SessionWatchDeps = { container: WatchedContainer; sessionId: string };

export type SessionHookEvent = AgentCallEvent & { sessionId: string };

export type SessionFailure = { container: string; node: string };

export class SessionWatch {
  started = false;
  private stopped = false;
  private readonly open = new Set<string>();
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
        return [...entries, ...this.onStop(event)];
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
      if (status === "running" || status === "needs-you") this.open.add(node.id);
    }
  }

  get openNode(): string | undefined {
    return this.open.values().next().value;
  }

  isOpen(nodeId: string): boolean {
    return this.open.has(nodeId);
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
    if (nodeId === undefined || this.finished.has(nodeId) || this.open.has(nodeId)) return [];
    this.open.add(nodeId);
    return [{ nodeId, event: { kind: "running" } }];
  }

  private onResult(event: SessionHookEvent): EventEntry[] {
    const nodeId = this.ownNode(event);
    if (nodeId === undefined || this.finished.has(nodeId)) return [];
    const opening = this.opening(nodeId);
    this.open.delete(nodeId);
    this.finished.add(nodeId);
    return [...opening, { nodeId, event: { kind: "done" } }];
  }

  private onStop(event: SessionHookEvent): EventEntry[] {
    const stoppedAt = this.stoppedAt(event);
    if (stoppedAt !== undefined) return this.failAt(stoppedAt.nodeId, stoppedAt.message);
    const stop = this.stopNode;
    if (stop === undefined || this.open.size > 0) return [];
    if (!hasFinishedPath(this.deps.container, this.finished)) return [];
    this.stopped = true;
    return this.finish(stop.id);
  }

  private stoppedAt(event: SessionHookEvent): { nodeId: string; message: string } | undefined {
    const message = event.payload["last_assistant_message"];
    const nodeId = stoppedNodeOf(typeof message === "string" ? message : undefined);
    const node = this.deps.container.nodes.find(({ id }) => id === nodeId);
    if (node === undefined || !stopsTheRun(node)) return undefined;
    if (node.type === "hardstop") {
      return { nodeId: node.id, message: `${node.id} failed: stopped by its hard stop` };
    }
    if (node.type === "loop") {
      const cap = (node.settings as { cap?: number } | undefined)?.cap;
      return { nodeId: node.id, message: `${node.id} failed: cap reached after ${cap} rounds` };
    }
    return undefined;
  }

  private finish(nodeId: string): EventEntry[] {
    this.finished.add(nodeId);
    return [
      { nodeId, event: { kind: "running" } },
      { nodeId, event: { kind: "done" } },
    ];
  }

  private opening(nodeId: string): EventEntry[] {
    return this.open.has(nodeId) ? [] : [{ nodeId, event: { kind: "running" } }];
  }

  failAt(nodeId: string, message: string): EventEntry[] {
    return this.failEach([nodeId], message);
  }

  fail(message: string): EventEntry[] {
    const stop = this.stopNode?.id;
    const nodeIds = this.open.size > 0 ? [...this.open] : stop === undefined ? [] : [stop];
    return nodeIds.length === 0 ? [] : this.failEach(nodeIds, message);
  }

  private failEach(nodeIds: readonly string[], message: string): EventEntry[] {
    if (this.stopped) return [];
    this.stopped = true;
    const failed: RunEvent = { kind: "failed", payload: { message } };
    return nodeIds.flatMap((nodeId) => {
      const opening = this.opening(nodeId);
      this.open.delete(nodeId);
      return [...opening, { nodeId, event: failed }];
    });
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
