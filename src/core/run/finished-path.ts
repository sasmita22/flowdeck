import type { ManifestContainer, ManifestNode } from "../compiler/lower.js";
import { ports as branchPorts } from "../nodes/branch/ports.js";
import { nodeStatus, type RunEvent } from "./run-events.js";
import type { NodeState } from "./state.js";

export type PathContainer = {
  nodes: readonly (Pick<ManifestNode, "id" | "type"> & { parent?: string | undefined })[];
  wires: ManifestContainer["wires"];
};

type Edge = { from: string; to: string; port: string };

const isFrame = (type: string | undefined) => type === "loop";

function pathGraph(container: PathContainer, finished: ReadonlySet<string>) {
  const { nodes } = container;
  const typeOf = new Map(nodes.map((node) => [node.id, node.type]));
  const frames = new Set(nodes.filter((node) => isFrame(node.type)).map((node) => node.id));
  const frameOf = new Map(
    nodes.flatMap((node) =>
      node.parent !== undefined && frames.has(node.parent) ? [[node.id, node.parent] as const] : [],
    ),
  );
  const thenWires = container.wires
    .filter((wire) => wire.kind === "then")
    .map((wire) => ({ from: wire.from.node, to: wire.to.node, port: wire.from.port }));

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
      return from === undefined || to === undefined || from === to
        ? []
        : [{ from, to, port: wire.port }];
    });

  const passable = (unit: string): boolean => {
    const type = typeOf.get(unit);
    if (type === "loop") return loopPasses(unit);
    return type !== "agent" || finished.has(unit);
  };

  const bodyOf = (frame: string) =>
    nodes.filter((node) => frameOf.get(node.id) === frame).map((node) => node.id);

  const entriesOf = (frame: string): string[] => {
    const edges = edgesIn(frame);
    const inBody = (id: string) => unitIn(frame, id) !== undefined;
    const entered = thenWires
      .filter((wire) => inBody(wire.to) && !inBody(wire.from))
      .flatMap((wire) => unitIn(frame, wire.to) ?? []);
    return entered.length > 0
      ? entered
      : bodyOf(frame).filter((id) => !edges.some((edge) => edge.to === id));
  };

  const loopPasses = (loop: string): boolean => {
    const edges = edgesIn(loop);
    if (edges.length === 0) return bodyOf(loop).every(passable);
    const inBody = (id: string) => unitIn(loop, id) !== undefined;
    const entries = entriesOf(loop);
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

  const agentsOf = (unit: string) =>
    nodes.filter(
      (node) => node.type === "agent" && (node.id === unit || unitIn(unit, node.id) !== undefined),
    );
  const finishedAgents = (unit: string) => agentsOf(unit).filter((node) => finished.has(node.id));

  const start = nodes.find((node) => node.type === "trigger");
  const stop = nodes.find((node) => node.type === "output");
  const topUnit = (id: string) => unitIn(undefined, id) ?? id;

  const leaves = (scope: string, unit: string) =>
    thenWires.some(
      (wire) => unitIn(scope, wire.from) === unit && unitIn(scope, wire.to) === undefined,
    );

  return {
    nodes,
    typeOf,
    leaves,
    passable,
    loopPasses,
    entriesOf,
    edgesIn,
    agentsOf,
    finishedAgents,
    start,
    stop,
    topUnit,
  };
}

export function hasFinishedPath(container: PathContainer, finished: ReadonlySet<string>): boolean {
  const { passable, edgesIn, start, stop, topUnit } = pathGraph(container, finished);
  if (start === undefined || stop === undefined) return false;
  const edges = edgesIn(undefined);
  const reached = new Set<string>();
  const pending = [topUnit(start.id)];
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    if (reached.has(at) || !passable(at)) continue;
    reached.add(at);
    pending.push(...edges.filter((edge) => edge.from === at).map((edge) => edge.to));
  }
  return reached.has(topUnit(stop.id));
}

type PathGraph = ReturnType<typeof pathGraph>;

type Beyond = {
  lands: (unit: string) => boolean;
  exits: (unit: string) => boolean;
  idle: (unit: string) => boolean;
};

function walkFrom(
  graph: PathGraph,
  finished: ReadonlySet<string>,
  scope: string | undefined,
  entries: readonly string[],
  beyond: Beyond,
) {
  const { typeOf, loopPasses, edgesIn, start, topUnit } = graph;
  const edges = edgesIn(scope);
  const after = (unit: string) => edges.filter((edge) => edge.from === unit);

  const reach = (units: readonly string[]): Set<string> => {
    const seen = new Set<string>();
    const pending = [...units];
    for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
      if (seen.has(at)) continue;
      seen.add(at);
      pending.push(...after(at).map((edge) => edge.to));
    }
    return seen;
  };

  const ranBeyond = (unit: string, shared: ReadonlySet<string>): boolean => {
    if (beyond.exits(unit)) return true;
    const seen = new Set<string>();
    const pending = after(unit).map((edge) => edge.to);
    for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
      if (seen.has(at) || shared.has(at)) continue;
      seen.add(at);
      if (beyond.lands(at)) return true;
      if (typeOf.get(at) === "agent") continue;
      if (beyond.exits(at)) return true;
      pending.push(...after(at).map((edge) => edge.to));
    }
    return false;
  };

  const passed = (unit: string, shared: ReadonlySet<string> = new Set()): boolean => {
    const type = typeOf.get(unit);
    if (start !== undefined && unit === topUnit(start.id)) return true;
    if (type === "agent") return finished.has(unit);
    if (isFrame(type) && loopPasses(unit)) return true;
    return ranBeyond(unit, shared);
  };

  const onward = (unit: string): string[] => {
    const out = after(unit);
    if (typeOf.get(unit) !== "branch") return out.map((edge) => edge.to);
    const otherSides = (port: string) =>
      reach(out.filter((edge) => edge.port !== port).map((edge) => edge.to));
    const ran = (edge: Edge, shared?: ReadonlySet<string>) =>
      shared?.has(edge.to) !== true &&
      !beyond.idle(edge.to) &&
      (beyond.lands(edge.to) || passed(edge.to, shared));
    const strict = out.filter((edge) => ran(edge, otherSides(edge.port)));
    const taken = new Set(
      (strict.length > 0 ? strict : out.filter((edge) => ran(edge))).map((edge) => edge.port),
    );
    return out.filter((edge) => taken.size === 0 || taken.has(edge.port)).map((edge) => edge.to);
  };

  const reached = new Set<string>();
  const frontier = new Set<string>();
  const pending: string[] = [];
  const visit = (unit: string) => {
    if (passed(unit)) pending.push(unit);
    else frontier.add(unit);
  };
  for (const entry of entries) visit(entry);
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    if (reached.has(at)) continue;
    reached.add(at);
    for (const unit of onward(at)) visit(unit);
  }
  return { reached, frontier, landsBeyond: (unit: string) => ranBeyond(unit, new Set()) };
}

export function carryOn(
  container: PathContainer,
  finished: ReadonlySet<string>,
  open: ReadonlySet<string>,
): string | undefined {
  const graph = pathGraph(container, finished);
  const { nodes, entriesOf, finishedAgents, start, stop, topUnit } = graph;
  const opened = nodes.find((node) => open.has(node.id));
  if (opened !== undefined) return opened.id;
  if (start === undefined) return stop?.id;

  const agentBeyond: Beyond = {
    lands: (unit) => finishedAgents(unit).length > 0,
    exits: () => false,
    idle: () => false,
  };

  const frontierIn = (
    scope: string | undefined,
    entries: readonly string[],
  ): string | undefined => {
    const { reached, frontier } = walkFrom(graph, finished, scope, entries, agentBeyond);
    const next = nodes.find((node) => frontier.has(node.id) && !reached.has(node.id));
    if (next === undefined) return undefined;
    if (!isFrame(next.type) || finishedAgents(next.id).length === 0) return next.id;
    return frontierIn(next.id, entriesOf(next.id)) ?? next.id;
  };

  return frontierIn(undefined, [topUnit(start.id)]) ?? stop?.id;
}

export function sessionStatesOf(
  container: PathContainer,
  events: readonly (RunEvent & { nodeId: string })[],
): Record<string, NodeState> {
  const raw = new Map(
    container.nodes.map((node) => [
      node.id,
      nodeStatus(events.filter((event) => event.nodeId === node.id)),
    ]),
  );
  const finished = new Set([...raw].flatMap(([id, state]) => (state === "done" ? [id] : [])));
  const graph = pathGraph(container, finished);
  const {
    nodes,
    typeOf,
    edgesIn,
    entriesOf,
    agentsOf,
    finishedAgents,
    leaves,
    start,
    stop,
    topUnit,
  } = graph;
  if (start === undefined || raw.get(start.id) === "waiting") return {};
  const ended = stop !== undefined && raw.get(stop.id) === "done";
  const stopUnit = stop === undefined ? undefined : topUnit(stop.id);

  const passed = new Set<string>();
  const walk = (scope: string | undefined, entries: readonly string[], exitLands: boolean) => {
    const edges = edgesIn(scope);
    const outPorts = (unit: string) =>
      typeOf.get(unit) === "branch"
        ? branchPorts.filter((port) => port.direction === "out").map((port) => port.name)
        : [];
    const ends = (unit: string) => {
      const out = edges.filter((edge) => edge.from === unit);
      return out.length === 0 || outPorts(unit).some((port) => !out.some((e) => e.port === port));
    };
    const { reached, frontier, landsBeyond } = walkFrom(graph, finished, scope, entries, {
      lands: (unit) => finishedAgents(unit).length > 0 || (ended && unit === stopUnit),
      exits: (unit) => exitLands && scope !== undefined && (ends(unit) || leaves(scope, unit)),
      idle: (unit) =>
        isFrame(typeOf.get(unit)) && agentsOf(unit).length > 0 && finishedAgents(unit).length === 0,
    });
    for (const unit of reached) passed.add(unit);
    for (const unit of [...reached, ...frontier]) {
      if (!isFrame(typeOf.get(unit))) continue;
      const through = reached.has(unit) && landsBeyond(unit);
      if (through || finishedAgents(unit).length > 0) walk(unit, entriesOf(unit), through);
    }
  };
  walk(undefined, [topUnit(start.id)], false);

  const derived = (id: string): NodeState | undefined => {
    if (raw.get(id) !== "waiting") return undefined;
    if (passed.has(id)) return "done";
    return ended ? "skipped" : undefined;
  };
  return Object.fromEntries(
    nodes.flatMap((node) => {
      const state = derived(node.id);
      return state === undefined ? [] : [[node.id, state]];
    }),
  );
}

export function sessionOverlayOf(
  sessionGroups: readonly PathContainer[],
  events: readonly (RunEvent & { nodeId: string })[],
): Record<string, NodeState> {
  return Object.assign({}, ...sessionGroups.map((group) => sessionStatesOf(group, events)));
}
