import type { Flow, FlowContainer, Node } from "./schema.js";
import { flowContainerMembers, flowContainerNodesOfType } from "./structure.js";

export type MainFlow = { reached: ReadonlySet<string>; ignored: readonly Node[] };

const frameTypes = new Set(["loop", "foreach"]);

const soleStart = (flow: Flow, container: FlowContainer): string | undefined => {
  const [start, ...otherStarts] = flowContainerNodesOfType(flow, container, "trigger");
  return otherStarts.length > 0 ? undefined : start;
};

export function mainFlow(flow: Flow): MainFlow | undefined {
  const byId = new Map(flow.nodes.map((node) => [node.id, node]));
  const starts = flow.containers.flatMap((container) => soleStart(flow, container) ?? []);
  if (starts.length === 0) return undefined;

  const reached = new Set<string>();
  const queue = [...starts];

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
  const kept = new Set([
    ...found.reached,
    ...flow.containers
      .filter((container) => soleStart(flow, container) === undefined)
      .flatMap((container) => flowContainerMembers(flow, container.id)),
  ]);
  return {
    ...flow,
    nodes: flow.nodes.filter((node) => kept.has(node.id)),
    wires: flow.wires.filter((wire) => kept.has(wire.from.node) && kept.has(wire.to.node)),
  };
}
