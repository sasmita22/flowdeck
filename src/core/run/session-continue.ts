import type { ManifestContainer, ManifestNode } from "../compiler/lower.js";
import { carryOn } from "./finished-path.js";
import { nodeStatus } from "./run-events.js";
import type { NodeState } from "./state.js";
import type { StoredEvent } from "./store.js";

type ContinueContainer = { nodes: readonly ManifestNode[]; wires: ManifestContainer["wires"] };

const named = (node: ManifestNode) => `NODE ${node.id} (${node.label})`;

const nodesIn = (
  container: ContinueContainer,
  events: readonly StoredEvent[],
  ...statuses: NodeState[]
) =>
  container.nodes.filter((node) =>
    statuses.includes(nodeStatus(events.filter((event) => event.nodeId === node.id))),
  );

const idsOf = (nodes: readonly ManifestNode[]) => new Set(nodes.map((node) => node.id));

export function carryOnNode(
  container: ContinueContainer,
  events: readonly StoredEvent[],
): ManifestNode | undefined {
  const next = carryOn(
    container,
    idsOf(nodesIn(container, events, "done")),
    idsOf(nodesIn(container, events, "running", "needs-you")),
  );
  return container.nodes.find((node) => node.id === next);
}

export function sessionContinuePrompt(
  container: ContinueContainer & { prefix: string },
  events: readonly StoredEvent[],
): string {
  const done = nodesIn(container, events, "done");
  const next = carryOnNode(container, events);
  const carryOnText = next === undefined ? "" : ` Carry on from ${named(next)};`;
  return `/${container.prefix}:run Already done: ${done.map(named).join(", ")}.${carryOnText} do not redo the done steps.`;
}
