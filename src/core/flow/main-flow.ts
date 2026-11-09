import type { Flow, Node } from "./schema.js";

export type MainFlow = { reached: ReadonlySet<string>; ignored: readonly Node[] };

const frameTypes = new Set(["loop", "foreach"]);

export function mainFlow(flow: Flow): MainFlow | undefined {
  const [start, ...otherStarts] = flow.nodes.filter((node) => node.type === "trigger");
  if (start === undefined || otherStarts.length > 0) return undefined;

  const byId = new Map(flow.nodes.map((node) => [node.id, node]));
  const reached = new Set<string>();
  const queue = [start.id];

  const neighbours = (id: string): string[] => {
    const node = byId.get(id);
    const along = flow.wires
      .filter((wire) => wire.kind !== "event" && wire.from.node === id)
      .map((wire) => wire.to.node);
    const frame = node?.parent === undefined ? [] : [node.parent];
    const body =
      node !== undefined && frameTypes.has(node.type)
        ? flow.nodes.filter((child) => child.parent === id).map((child) => child.id)
        : [];
    return [...along, ...frame, ...body];
  };

  for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
    if (reached.has(id)) continue;
    reached.add(id);
    queue.push(...neighbours(id));
  }

  return { reached, ignored: flow.nodes.filter((node) => !reached.has(node.id)) };
}

export function mainFlowOnly(flow: Flow): Flow {
  const found = mainFlow(flow);
  if (found === undefined) return flow;
  const { reached } = found;
  return {
    ...flow,
    nodes: flow.nodes.filter((node) => reached.has(node.id)),
    wires: flow.wires.filter((wire) => reached.has(wire.from.node) && reached.has(wire.to.node)),
  };
}
