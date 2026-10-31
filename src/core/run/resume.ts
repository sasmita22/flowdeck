import type { ManifestNode } from "../compiler/lower.js";
import { agentType } from "../nodes/agent/execute.js";
import { nodeStatus } from "./run-events.js";
import type { NodeState } from "./state.js";
import type { StoredEvent } from "./store.js";
import type { HumanDecision } from "./wait.js";

export type TranscriptTurn = { userText: string; ended: boolean; lastAssistantText?: string };

export type ResumeAction =
  | { kind: "send" }
  | { kind: "wait" }
  | { kind: "complete"; stopMessage?: string }
  | { kind: "fail"; message: string }
  | { kind: "reuse"; decision: HumanDecision }
  | { kind: "ask" };

export type ResumeActions = Record<string, ResumeAction>;

export class ResumeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResumeError";
  }
}

type ResumeInput = {
  manifest: { hash: string; nodes: readonly ManifestNode[] };
  events: readonly StoredEvent[];
  turns: readonly TranscriptTurn[];
};

const humanTypes = new Set<ManifestNode["type"]>(["gate", "ask", "hardstop", "loop"]);

function turnMarker(node: ManifestNode, hash: string): string {
  return node.type === "agent"
    ? `subagent_type "${agentType(hash, node.id)}"`
    : `<command-name>/${hash}:${node.id}</command-name>`;
}

function settleTurn(
  node: ManifestNode,
  hash: string,
  events: readonly StoredEvent[],
  turns: readonly TranscriptTurn[],
): ResumeAction {
  const sends = events.filter((event) => event.kind === "sent").length;
  const marker = turnMarker(node, hash);
  const matching = turns.filter((turn) => turn.userText.includes(marker));
  if (matching.length === sends - 1) return { kind: "send" };
  const last = matching.at(-1);
  if (matching.length !== sends || last === undefined) {
    throw new ResumeError(
      `cannot resume ${node.id}: it was sent ${sends} times but the transcript holds ${matching.length} of its turns`,
    );
  }
  if (!last.ended) return { kind: "wait" };
  return last.lastAssistantText === undefined
    ? { kind: "complete" }
    : { kind: "complete", stopMessage: last.lastAssistantText };
}

function settleHuman(events: readonly StoredEvent[]): ResumeAction {
  const asked = events.findLastIndex((event) => event.kind === "needs-you");
  const recorded = events
    .slice(asked + 1)
    .find((event) => event.kind === "decided" || event.kind === "answered");
  return recorded?.kind === "decided" || recorded?.kind === "answered"
    ? { kind: "reuse", decision: recorded.payload }
    : { kind: "ask" };
}

function sectionInterrupted(node: ManifestNode, status: NodeState, interrupted: boolean): boolean {
  if (node.type === "fork") return status === "sent";
  if (node.type === "join") return status === "running";
  return interrupted && node.type === "agent" && status === "sent";
}

export function decideResume({ manifest, events, turns }: ResumeInput): ResumeActions {
  const actions: ResumeActions = {};
  const statusOf = (id: string) => nodeStatus(events.filter((event) => event.nodeId === id));
  const interrupted = manifest.nodes.some(
    (node) => node.type === "fork" && statusOf(node.id) === "sent",
  );
  for (const node of manifest.nodes) {
    const own = events.filter((event) => event.nodeId === node.id);
    const status = nodeStatus(own);
    if (sectionInterrupted(node, status, interrupted)) {
      actions[node.id] = {
        kind: "fail",
        message: `${node.id} failed: parallel section was interrupted; start a new run`,
      };
      continue;
    }
    if (status === "sent") actions[node.id] = settleTurn(node, manifest.hash, own, turns);
    if (status === "running" && node.type === "script") {
      actions[node.id] = {
        kind: "fail",
        message: `${node.id} failed: was running when the runner stopped`,
      };
    }
    if (status === "needs-you" && humanTypes.has(node.type)) actions[node.id] = settleHuman(own);
  }
  return actions;
}
