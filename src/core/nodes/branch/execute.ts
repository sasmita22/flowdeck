import type { Node, Wire } from "../../flow/schema.js";
import type { VariableValues } from "../../flow/variables.js";
import type { StoredEvent } from "../../run/store.js";
import { producedRows } from "../agent/execute.js";
import type { SectionNode } from "../fork/execute.js";

export type BranchPort = "yes" | "no";

export const portOf = (answer: boolean): BranchPort => (answer ? "yes" : "no");

export function branchDecision(
  events: readonly StoredEvent[],
  values: VariableValues | undefined,
  settings: { variable: string },
): BranchPort | undefined {
  const name = settings.variable;
  const produced = events.findLast(
    (event) => event.kind === "done" && typeof event.payload?.variables?.[name] === "boolean",
  );
  const value = produced?.kind === "done" ? produced.payload?.variables?.[name] : values?.[name];
  return typeof value === "boolean" ? portOf(value) : undefined;
}

export const producersOf = (
  nodes: readonly { id: string; settings: Node["settings"] }[],
  name: string,
): ReadonlySet<string> =>
  new Set(
    nodes
      .filter((node) => producedRows(node.settings).some((row) => row.variable === name))
      .map((node) => node.id),
  );

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
  const containers = new Set(nodes.filter((node) => node.type === "loop").map((node) => node.id));
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
