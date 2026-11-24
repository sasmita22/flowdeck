import type { ManifestContainer, ManifestNode } from "../compiler/lower.js";

export type PathContainer = {
  nodes: readonly Pick<ManifestNode, "id" | "type" | "parent">[];
  wires: ManifestContainer["wires"];
};

type Edge = { from: string; to: string };

export function hasFinishedPath(container: PathContainer, finished: ReadonlySet<string>): boolean {
  const { nodes } = container;
  const typeOf = new Map(nodes.map((node) => [node.id, node.type]));
  const frames = new Set(
    nodes.filter((node) => node.type === "loop" || node.type === "foreach").map((node) => node.id),
  );
  const frameOf = new Map(
    nodes.flatMap((node) =>
      node.parent !== undefined && frames.has(node.parent) ? [[node.id, node.parent] as const] : [],
    ),
  );
  const thenWires = container.wires
    .filter((wire) => wire.kind === "then")
    .map((wire) => ({ from: wire.from.node, to: wire.to.node }));

  const unitIn = (scope: string | undefined, id: string): string | undefined => {
    const seen = new Set<string>();
    for (let at: string | undefined = id; at !== undefined && !seen.has(at); at = frameOf.get(at)) {
      seen.add(at);
      if (frameOf.get(at) === scope) return at;
    }
    return undefined;
  };

  const edgesIn = (scope: string | undefined): Edge[] =>
    thenWires.flatMap((wire) => {
      const from = unitIn(scope, wire.from);
      const to = unitIn(scope, wire.to);
      return from === undefined || to === undefined || from === to ? [] : [{ from, to }];
    });

  const passable = (unit: string): boolean => {
    const type = typeOf.get(unit);
    if (type === "foreach") return true;
    if (type === "loop") return loopPasses(unit);
    return type !== "agent" || finished.has(unit);
  };

  const loopPasses = (loop: string): boolean => {
    const body = nodes.filter((node) => frameOf.get(node.id) === loop).map((node) => node.id);
    const edges = edgesIn(loop);
    if (edges.length === 0) return body.every(passable);
    const inBody = (id: string) => unitIn(loop, id) !== undefined;
    const entered = thenWires
      .filter((wire) => inBody(wire.to) && !inBody(wire.from))
      .flatMap((wire) => unitIn(loop, wire.to) ?? []);
    const entries =
      entered.length > 0 ? entered : body.filter((id) => !edges.some((edge) => edge.to === id));
    const leaves = (id: string) =>
      thenWires.some((wire) => unitIn(loop, wire.from) === id && !inBody(wire.to));
    const walk = (at: string, path: ReadonlySet<string>): boolean => {
      if (!passable(at)) return false;
      const next = edges.filter((edge) => edge.from === at).map((edge) => edge.to);
      if (leaves(at) || next.every((id) => path.has(id))) return true;
      return next.some((id) => !path.has(id) && walk(id, new Set([...path, id])));
    };
    return entries.some((entry) => walk(entry, new Set([entry])));
  };

  const start = nodes.find((node) => node.type === "trigger");
  const stop = nodes.find((node) => node.type === "output");
  if (start === undefined || stop === undefined) return false;
  const edges = edgesIn(undefined);
  const reached = new Set<string>();
  const pending = [unitIn(undefined, start.id) ?? start.id];
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    if (reached.has(at) || !passable(at)) continue;
    reached.add(at);
    pending.push(...edges.filter((edge) => edge.from === at).map((edge) => edge.to));
  }
  return reached.has(unitIn(undefined, stop.id) ?? stop.id);
}
