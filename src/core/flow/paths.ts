import type { Flow } from "./schema.js";

const frameTypes = new Set(["loop", "foreach"]);

const successorsIn = (flow: Flow) => {
  const byId = new Map(flow.nodes.map((node) => [node.id, node]));
  const thenWires = flow.wires.filter((wire) => wire.kind === "then");
  const childrenOf = (frame: string) => flow.nodes.filter((node) => node.parent === frame);
  const inside = (id: string, frame: string): boolean => {
    const parent = byId.get(id)?.parent;
    return parent !== undefined && (parent === frame || inside(parent, frame));
  };
  const along = (id: string) =>
    thenWires
      .filter((wire) => wire.from.node === id && !inside(wire.to.node, id))
      .map((wire) => wire.to.node);
  const entries = (frame: string) =>
    childrenOf(frame)
      .filter(
        (child) =>
          !thenWires.some(
            (wire) =>
              (wire.to.node === child.id || inside(wire.to.node, child.id)) &&
              inside(wire.from.node, frame) &&
              wire.from.node !== child.id &&
              !inside(wire.from.node, child.id),
          ),
      )
      .map((child) => child.id);
  const leaving = (id: string): string[] => {
    const next = along(id);
    const parent = byId.get(id)?.parent;
    return next.length > 0 || parent === undefined ? next : leaving(parent);
  };

  return (id: string): string[] => {
    const node = byId.get(id);
    const body = node !== undefined && frameTypes.has(node.type) ? entries(id) : [];
    return [...leaving(id), ...body];
  };
};

const search = (flow: Flow, from: readonly string[], blocked: ReadonlySet<string>) => {
  const successors = successorsIn(flow);
  const reached = new Set<string>();
  const queue = from.filter((id) => !blocked.has(id));
  for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
    if (reached.has(id)) continue;
    reached.add(id);
    queue.push(...successors(id).filter((next) => !blocked.has(next)));
  }
  return reached;
};

export const reachableFrom = (flow: Flow, nodeId: string): ReadonlySet<string> =>
  search(flow, [nodeId], new Set());

export const coveredOnEveryPath = (
  flow: Flow,
  target: string,
  sourceIds: readonly string[],
): boolean => {
  const starts = flow.nodes.filter((node) => node.type === "trigger").map((node) => node.id);
  return !search(flow, starts, new Set(sourceIds)).has(target);
};
