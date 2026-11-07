import type { Manifest } from "../compiler/lower.js";
import { parallelSections, type ParallelSection } from "../nodes/fork/execute.js";
import { nodeStatus } from "./run-events.js";
import type { NodeState } from "./state.js";
import type { EventEntry, StoredEvent } from "./store.js";

type RetryManifest = Pick<Manifest, "nodes" | "wires">;

const statusIn = (events: readonly StoredEvent[], nodeId: string) =>
  nodeStatus(events.filter((event) => event.nodeId === nodeId));

function withFamily(manifest: RetryManifest, nodeId: string): Set<string> {
  const parentOf = new Map(manifest.nodes.map((node) => [node.id, node.parent]));
  const family = new Set<string>([nodeId]);
  for (let at = parentOf.get(nodeId); at !== undefined; at = parentOf.get(at)) family.add(at);
  const pending = [...family];
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    for (const child of manifest.nodes.filter((node) => node.parent === id)) {
      if (!family.has(child.id)) {
        family.add(child.id);
        pending.push(child.id);
      }
    }
  }
  return family;
}

const inTurn: readonly NodeState[] = ["sent", "running", "needs-you"];

export const rerunsOnRetry = (status: NodeState) => status !== "done" && status !== "skipped";

function sectionRetryEntries(section: ParallelSection, events: readonly StoredEvent[]) {
  const rerun = section.branches.filter((branch) => rerunsOnRetry(statusIn(events, branch)));
  return [section.fork, section.join, ...rerun].flatMap((id): EventEntry[] => {
    const status = statusIn(events, id);
    if (status === "waiting") return [];
    const retry: EventEntry = { nodeId: id, event: { kind: "retry" } };
    if (!inTurn.includes(status)) return [retry];
    const message = `${id} failed: parallel section was interrupted`;
    return [{ nodeId: id, event: { kind: "failed", payload: { message } } }, retry];
  });
}

export function retryEntries(
  manifest: RetryManifest,
  events: readonly StoredEvent[],
  nodeId: string,
): EventEntry[] {
  if (statusIn(events, nodeId) !== "failed") throw new Error(`${nodeId} has not failed`);
  const { sections } = parallelSections(manifest.nodes, manifest.wires);
  const section = sections.find((candidate) =>
    [candidate.fork, candidate.join, ...candidate.branches].includes(nodeId),
  );
  if (section) return sectionRetryEntries(section, events);
  const family = withFamily(manifest, nodeId);
  return manifest.nodes.flatMap((node): EventEntry[] =>
    family.has(node.id) && statusIn(events, node.id) === "failed"
      ? [{ nodeId: node.id, event: { kind: "retry" } }]
      : [],
  );
}

export const resumeEntries = (
  manifest: Pick<Manifest, "nodes">,
  events: readonly StoredEvent[],
): EventEntry[] =>
  manifest.nodes.flatMap((node): EventEntry[] =>
    node.type === "script" && statusIn(events, node.id) === "running"
      ? [{ nodeId: node.id, event: { kind: "retry" } }]
      : [],
  );
