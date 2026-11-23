import type { ManifestNode } from "../compiler/lower.js";
import { nodeStatus } from "./run-events.js";
import type { StoredEvent } from "./store.js";

const named = (node: ManifestNode) => `NODE ${node.id} (${node.label})`;

const doneIn = (events: readonly StoredEvent[]) => (node: ManifestNode) =>
  nodeStatus(events.filter((event) => event.nodeId === node.id)) === "done";

export function carryOnNode(
  container: { nodes: readonly ManifestNode[] },
  events: readonly StoredEvent[],
): ManifestNode | undefined {
  const isDone = doneIn(events);
  return (
    container.nodes.find((node) => !isDone(node)) ??
    container.nodes.find((node) => node.type === "output")
  );
}

export function sessionContinuePrompt(
  container: { prefix: string; nodes: readonly ManifestNode[] },
  events: readonly StoredEvent[],
): string {
  const isDone = doneIn(events);
  const done = container.nodes.filter(isDone);
  const next = container.nodes.find((node) => !isDone(node));
  const carryOn = next === undefined ? "" : ` Carry on from ${named(next)};`;
  return `/${container.prefix}:run Already done: ${done.map(named).join(", ")}.${carryOn} do not redo the done steps.`;
}
