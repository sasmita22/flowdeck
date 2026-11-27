import type { LibraryLookup } from "./libraries.js";
import type { Flow, FlowContainer, Node } from "./schema.js";
import {
  flowContainerMembers,
  flowContainerNodesOfType,
  flowContainerOf,
  isWorkflow,
} from "./structure.js";

type CanvasReach = { reached: ReadonlySet<string>; containers: ReadonlySet<string> };

type MainFlow = CanvasReach & { ignored: readonly Node[] };

const frameTypes = new Set(["loop"]);

const soleStart = (flow: Flow, container: FlowContainer): string | undefined => {
  const [start, ...otherStarts] = flowContainerNodesOfType(flow, container, "trigger");
  return otherStarts.length > 0 ? undefined : start;
};

export function canvasStart(flow: Flow): string | undefined {
  const [start, ...others] = flow.nodes.filter(
    (node) =>
      node.type === "trigger" &&
      node.parent === undefined &&
      flowContainerOf(flow, node.id) === undefined,
  );
  return others.length > 0 ? undefined : start?.id;
}

function walk(flow: Flow, seeds: readonly string[]): CanvasReach {
  const byId = new Map(flow.nodes.map((node) => [node.id, node]));
  const containerById = new Map(flow.containers.map((container) => [container.id, container]));
  const reached = new Set<string>();
  const containers = new Set<string>();
  const queue = [...seeds];

  const along = (id: string) =>
    flow.wires
      .filter((wire) => wire.kind !== "event" && wire.from.node === id)
      .map((wire) => wire.to.node);

  const neighbours = (id: string): string[] => {
    const container = containerById.get(id);
    if (container !== undefined) {
      const start = soleStart(flow, container);
      return [...(start === undefined ? [] : [start]), ...along(id)];
    }
    const node = byId.get(id);
    const frame = node?.parent === undefined ? [] : [node.parent];
    const body =
      node !== undefined && frameTypes.has(node.type)
        ? flow.nodes.filter((child) => child.parent === id).map((child) => child.id)
        : [];
    return [...along(id), ...frame, ...body];
  };

  for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
    const seen = containerById.has(id) ? containers : reached;
    if (seen.has(id)) continue;
    seen.add(id);
    queue.push(...neighbours(id));
  }

  return { reached, containers };
}

export function canvasReach(flow: Flow): CanvasReach | undefined {
  const start = canvasStart(flow);
  return start === undefined ? undefined : walk(flow, [start]);
}

export const reachFrom = (flow: Flow, id: string): CanvasReach => walk(flow, [id]);

export function mainFlow(flow: Flow, libraries?: LibraryLookup): MainFlow | undefined {
  const start = canvasStart(flow);
  const containerSeeds = isWorkflow(flow)
    ? flow.containers
        .filter((container) => soleStart(flow, container) !== undefined)
        .map((container) => container.id)
    : [];
  const librarySeeds = isWorkflow(flow)
    ? flow.nodes
        .filter(
          (node) =>
            node.type === "library" &&
            node.parent === undefined &&
            flowContainerOf(flow, node.id) === undefined &&
            libraries?.(node.settings.libraryId)?.kind === "session-library",
        )
        .map((node) => node.id)
    : [];
  const seeds = [...containerSeeds, ...librarySeeds, ...(start === undefined ? [] : [start])];
  if (seeds.length === 0) return undefined;

  const { reached, containers } = walk(flow, seeds);
  return { reached, containers, ignored: flow.nodes.filter((node) => !reached.has(node.id)) };
}

export function mainFlowOnly(flow: Flow, libraries?: LibraryLookup): Flow {
  const found = mainFlow(flow, libraries);
  if (found === undefined) return flow;
  const kept = new Set([
    ...found.reached,
    ...found.containers,
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
