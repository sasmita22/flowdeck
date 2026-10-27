import type { Flow } from "./schema.js";

export class FlowCycleError extends Error {
  readonly nodeIds: string[];

  constructor(nodeIds: string[]) {
    super(`cycle through ${nodeIds.join(", ")}`);
    this.name = "FlowCycleError";
    this.nodeIds = nodeIds;
  }
}

type Scope = string | undefined;
type Edge = { from: string; to: string };

export function order(flow: Flow): string[] {
  const index = new Map(flow.nodes.map((node, i) => [node.id, i]));
  const parentOf = new Map<string, Scope>(
    flow.nodes.map((node) => [
      node.id,
      node.parent !== undefined && index.has(node.parent) ? node.parent : undefined,
    ]),
  );
  const byArrayOrder = (ids: Iterable<string>) =>
    [...ids].sort((a, b) => (index.get(a) ?? 0) - (index.get(b) ?? 0));

  const ancestors = (id: string): string[] => {
    const chain: string[] = [];
    for (let at = parentOf.get(id); at !== undefined; at = parentOf.get(at)) {
      if (at === id || chain.includes(at)) throw new FlowCycleError(byArrayOrder([id, ...chain]));
      chain.push(at);
    }
    return chain;
  };
  const ancestorsOf = new Map(flow.nodes.map((node) => [node.id, ancestors(node.id)]));

  const inside = (id: string, scope: string) => ancestorsOf.get(id)?.includes(scope) ?? false;
  const unitIn = (scope: Scope, id: string): string => {
    let unit = id;
    while (parentOf.get(unit) !== scope) unit = parentOf.get(unit) ?? unit;
    return unit;
  };
  const deepestCommonScope = (a: string, b: string): Scope =>
    ancestorsOf.get(a)?.find((scope) => inside(b, scope));

  const wires = flow.wires.filter(
    (wire) => wire.kind === "then" && index.has(wire.from.node) && index.has(wire.to.node),
  );

  const entriesOf = (scope: string): Set<string> =>
    new Set(
      wires
        .filter((wire) => inside(wire.to.node, scope))
        .filter((wire) => wire.from.node === scope || !inside(wire.from.node, scope))
        .map((wire) => unitIn(scope, wire.to.node)),
    );

  const edgesIn = (scope: Scope): Edge[] => {
    const entries = scope === undefined ? new Set<string>() : entriesOf(scope);
    const edges: Edge[] = [];
    for (const wire of wires) {
      const from = wire.from.node;
      const to = wire.to.node;
      if (deepestCommonScope(from, to) !== scope) continue;
      const edge = { from: unitIn(scope, from), to: unitIn(scope, to) };
      if (edge.from === edge.to && from !== to) continue;
      if (entries.has(edge.to)) continue;
      edges.push(edge);
    }
    return edges;
  };

  const scopes = new Set([...parentOf.values()].filter((scope) => scope !== undefined));

  const cycleMembers = (remaining: Set<string>, edges: Edge[]): string[] => {
    const left = new Set(remaining);
    let dropped = true;
    while (dropped) {
      dropped = false;
      for (const unit of left) {
        if (!edges.some((e) => e.from === unit && left.has(e.to))) {
          left.delete(unit);
          dropped = true;
        }
      }
    }
    return byArrayOrder(left);
  };

  const orderScope = (scope: Scope): string[] => {
    const units = flow.nodes.map((node) => node.id).filter((id) => parentOf.get(id) === scope);
    const edges = edgesIn(scope);
    const remaining = new Set(units);
    const ordered: string[] = [];
    for (;;) {
      const ready = units.find(
        (unit) => remaining.has(unit) && !edges.some((e) => e.to === unit && remaining.has(e.from)),
      );
      if (ready === undefined) break;
      remaining.delete(ready);
      ordered.push(ready);
    }
    if (remaining.size > 0) throw new FlowCycleError(cycleMembers(remaining, edges));
    return ordered.flatMap((unit) => (scopes.has(unit) ? [unit, ...orderScope(unit)] : [unit]));
  };

  return orderScope(undefined);
}
