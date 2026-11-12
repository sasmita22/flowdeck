import type { Node, Wire } from "../../flow/schema.js";
import type { VariableValues } from "../../flow/variables.js";
import type { StoredEvent } from "../../run/store.js";
import { parseProducedValue, type ProducedValue } from "../../run/verdict.js";
import type { HumanOutcome, WaitReply, WaitRequest } from "../../run/wait.js";
import { producedName } from "../agent/settings.js";
import type { SectionNode } from "../fork/execute.js";

export type BranchPort = "yes" | "no";

export function triggerFlags(
  nodes: readonly Pick<Node, "type" | "settings">[],
): Record<string, boolean> {
  const flags: Record<string, boolean> = {};
  for (const node of nodes) {
    if (node.type !== "trigger" || !("flags" in node.settings)) continue;
    for (const [name, value] of Object.entries(node.settings.flags)) {
      if (typeof value === "boolean" && !(name in flags)) flags[name] = value;
    }
  }
  return flags;
}

export function branchTakes(
  flag: string,
  defaults: Readonly<Record<string, boolean>>,
  overrides: Readonly<Record<string, boolean>>,
): BranchPort {
  const value = overrides[flag] ?? defaults[flag];
  if (typeof value !== "boolean") {
    throw new Error(`Branch variable "${flag}" is not a yes/no variable on the blueprint.`);
  }
  return value ? "yes" : "no";
}

export function branchDecision(
  manifest: { nodes: readonly Pick<Node, "type" | "settings">[]; values?: VariableValues },
  settings: { variable?: string; flag?: string },
  flags: Readonly<Record<string, boolean>>,
): BranchPort {
  const name = settings.variable ?? settings.flag ?? "";
  if (manifest.values === undefined) return branchTakes(name, triggerFlags(manifest.nodes), flags);
  const value = manifest.values[name];
  if (typeof value !== "boolean") {
    throw new Error(`Branch variable "${name}" has no yes/no value in this build.`);
  }
  return value ? "yes" : "no";
}

export const producersOf = (
  nodes: readonly { id: string; settings: Node["settings"] }[],
  name: string,
): ReadonlySet<string> =>
  new Set(nodes.filter((node) => producedName(node.settings) === name).map((node) => node.id));

export function producedAnswer(
  events: readonly StoredEvent[],
  producers: ReadonlySet<string>,
  name: string,
): ProducedValue {
  const done = events.findLast((event) => event.kind === "done" && producers.has(event.nodeId));
  if (done?.kind !== "done") return { kind: "malformed", reason: "no Agent produced it" };
  const stored = done.payload?.produced;
  if (stored?.name === name) return { kind: "value", answer: stored.answer };
  return parseProducedValue(done.payload?.stopMessage, name);
}

export const portOf = (answer: boolean): BranchPort => (answer ? "yes" : "no");

export const isBranchPort = (answer: string): answer is BranchPort =>
  answer === "yes" || answer === "no";

export function valueRequest(branchId: string, name: string, reason: string): WaitRequest {
  return {
    nodeId: branchId,
    kind: "ask",
    question: `no readable yes/no answer for "${name}" (${reason}). Which path does the run take?`,
    options: ["yes", "no", "fail"],
  };
}

export function valueAnswer(branchId: string, name: string, reply: WaitReply): HumanOutcome {
  if (reply.decision === "closed") return { status: "failed", reason: "no answer: input closed" };
  if (reply.decision !== "answer") {
    return { status: "failed", reason: `unexpected reply: ${reply.decision}` };
  }
  const decision = { nodeId: branchId, decision: "answered", answer: reply.answer } as const;
  if (reply.answer === "fail") {
    return { status: "failed", reason: `no yes/no answer for "${name}"`, decision };
  }
  if (!isBranchPort(reply.answer)) {
    return { status: "failed", reason: `unexpected answer: ${reply.answer}` };
  }
  return { status: "done", line: `answered: ${reply.answer}`, decision };
}

export function branchSkips(input: {
  branchId: string;
  decisions: ReadonlyMap<string, BranchPort>;
  nodes: readonly SectionNode[];
  wires: readonly Wire[];
  eligible: ReadonlySet<string>;
}): string[] {
  const { branchId, decisions, nodes, wires, eligible } = input;
  const taken = decisions.get(branchId);
  if (taken === undefined) throw new Error(`Branch "${branchId}" has not decided.`);
  const thenWires = wires.filter((wire) => wire.kind === "then");
  const fromBranch = (port: BranchPort) =>
    thenWires
      .filter((wire) => wire.from.node === branchId && wire.from.port === port)
      .map((wire) => wire.to.node);
  const notTaken = taken === "yes" ? "no" : "yes";
  const followed = thenWires.filter((wire) => {
    const decided = decisions.get(wire.from.node);
    return decided === undefined || wire.from.port === decided;
  });
  const containers = new Set(
    nodes.filter((node) => node.type === "loop" || node.type === "foreach").map((node) => node.id),
  );
  const parentOf = new Map(nodes.map((node) => [node.id, node.parent]));
  const bodyOf = (id: string) =>
    containers.has(id) ? nodes.filter((node) => node.parent === id).map((node) => node.id) : [];
  const containersOf = (id: string) => {
    const chain: string[] = [];
    for (let at = parentOf.get(id); at !== undefined && containers.has(at); at = parentOf.get(at)) {
      if (chain.includes(at)) break;
      chain.push(at);
    }
    return chain;
  };
  const unitOf = (id: string) => containersOf(id).at(-1) ?? id;
  const reach = (from: readonly string[]) => {
    const reached = new Set<string>();
    const pending = [...from];
    for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
      if (reached.has(id)) continue;
      reached.add(id);
      pending.push(
        ...followed.filter((wire) => wire.from.node === id).map((wire) => wire.to.node),
        ...bodyOf(id),
        ...containersOf(id),
      );
    }
    return reached;
  };

  const wiredInto = new Set(
    thenWires
      .filter((wire) => unitOf(wire.from.node) !== unitOf(wire.to.node))
      .map((wire) => unitOf(wire.to.node)),
  );
  const roots = nodes
    .filter((node) => node.parent === undefined && !wiredInto.has(node.id))
    .map((node) => node.id);
  const live = reach([...roots, ...fromBranch(taken)]);
  const skipped = new Set([...reach(fromBranch(notTaken))].filter((id) => !live.has(id)));
  return nodes.map((node) => node.id).filter((id) => skipped.has(id) && eligible.has(id));
}
