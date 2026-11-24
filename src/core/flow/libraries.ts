import { decidedByValue } from "../nodes/branch/settings.js";
import { canvasStart, mainFlow, mainFlowOnly } from "./main-flow.js";
import type { Connection, Flow, FlowContainer, Node, SessionContainer, Wire } from "./schema.js";
import { flowContainerOf, isWorkflow } from "./structure.js";
import { fillVariables, referencedVariables, type LibraryUse } from "./variables.js";

export type BlueprintKind = "workflow" | "node-library" | "session-library" | "incomplete";

export type LibraryResolver = (flowId: string) => { name: string; flow: Flow } | undefined;

export type LibrarySession = Pick<SessionContainer, "id" | "name" | "repo" | "branch" | "model">;

export type LibraryLookup = (
  flowId: string,
) =>
  | { name: string; kind: BlueprintKind; sessions: LibrarySession[]; uses: readonly string[] }
  | undefined;

export const libraryUses = (flow: Flow): string[] => [
  ...new Set(
    flow.nodes.flatMap((node) =>
      node.type === "library" && node.settings.libraryId !== "" ? [node.settings.libraryId] : [],
    ),
  ),
];

export function libraryLoop(
  usesOf: (id: string) => readonly string[] | undefined,
  hostId: string | undefined,
  libraryId: string,
): string[] | undefined {
  if (libraryId === hostId) return [hostId, hostId];
  const visiting: string[] = [];
  const finished = new Set<string>();
  const walk = (id: string): string[] | undefined => {
    visiting.push(id);
    for (const used of usesOf(id) ?? []) {
      if (used === hostId) return [hostId, ...visiting, hostId];
      const repeat = visiting.indexOf(used);
      if (repeat >= 0) return [...visiting.slice(repeat), used];
      if (finished.has(used)) continue;
      const path = walk(used);
      if (path !== undefined) return path;
    }
    visiting.pop();
    finished.add(id);
    return undefined;
  };
  return walk(libraryId);
}

export const loopReason = (
  path: readonly string[],
  nameOf: (id: string) => string | undefined,
): string => `makes a loop: ${path.map((id) => nameOf(id) ?? id).join(" → ")}`;

export const libraryLoopReason = (
  libraryId: string,
  path: readonly string[],
  nameOf: (id: string) => string | undefined,
): string => `${nameOf(libraryId) ?? libraryId} ${loopReason(path, nameOf)}`;

export const unknownLibraries: LibraryLookup = () => undefined;

type KindOf = (flowId: string) => BlueprintKind | undefined;

type LibraryNode = Extract<Node, { type: "library" }>;

type Overrides = LibraryNode["settings"]["overrides"];

type Expanded = { flow: Flow; uses: LibraryUse[] };

export class LibraryError extends Error {}

export class LibraryLoopError extends LibraryError {}

export const labelPrefix = (label: string): string => label.toLowerCase().replace(/\s+/g, "-");

const atCanvasLevel = (flow: Flow, node: Node): boolean =>
  node.parent === undefined && flowContainerOf(flow, node.id) === undefined;

const canvasStops = (flow: Flow): Set<string> =>
  new Set(
    flow.nodes
      .filter((node) => node.type === "output" && atCanvasLevel(flow, node))
      .map((node) => node.id),
  );

const isSession = (container: FlowContainer): container is SessionContainer =>
  container.kind === "session";

export function blueprintKind(flow: Flow, kindOf: KindOf = () => undefined): BlueprintKind {
  if (isWorkflow(flow)) return "workflow";
  const found = mainFlow(flow);
  if (found === undefined) return "incomplete";
  const reached = flow.nodes.filter((node) => found.reached.has(node.id));
  const stops = canvasStops(flow);
  if (!reached.some((node) => stops.has(node.id))) return "incomplete";
  const throughSession =
    flow.containers.some(
      (container) => isSession(container) && found.containers.has(container.id),
    ) ||
    reached.some(
      (node) => node.type === "library" && kindOf(node.settings.libraryId) === "session-library",
    );
  return throughSession ? "session-library" : "node-library";
}

export function kindResolver(resolve: LibraryResolver): KindOf {
  const known = new Map<string, BlueprintKind>();
  const visiting: string[] = [];
  const looped = new Set<string>();
  const kindOf: KindOf = (flowId) => {
    const cached = known.get(flowId);
    if (cached !== undefined) return cached;
    const repeat = visiting.indexOf(flowId);
    if (repeat >= 0) {
      for (const id of visiting.slice(repeat)) looped.add(id);
      return undefined;
    }
    const library = resolve(flowId);
    if (library === undefined) return undefined;
    visiting.push(flowId);
    const kind = blueprintKind(library.flow, kindOf);
    visiting.pop();
    if (!looped.has(flowId)) known.set(flowId, kind);
    return kind;
  };
  return kindOf;
}

export function libraryLookup(resolve: LibraryResolver): LibraryLookup {
  const kindOf = kindResolver(resolve);
  return (flowId) => {
    const library = resolve(flowId);
    const kind = kindOf(flowId);
    if (library === undefined || kind === undefined) return undefined;
    const sessions =
      kind === "node-library" || kind === "session-library"
        ? reachedSessions(expandedOrAsIs(library.flow, resolve).flow)
        : [];
    return { name: library.name, kind, sessions, uses: libraryUses(library.flow) };
  };
}

const firstFree = (base: string, taken: ReadonlySet<string>): string => {
  if (!taken.has(base)) return base;
  for (let count = 2; ; count++) {
    const name = `${base}-${count}`;
    if (!taken.has(name)) return name;
  }
};

const prefixedText = (text: string, prefix: string): string =>
  fillVariables(
    text,
    Object.fromEntries(
      referencedVariables(text)
        .filter((name) => name !== "")
        .map((name) => [name, `{{${prefix}.${name}}}`]),
    ),
  );

const withPrefixedVariables = (node: Node, prefix: string): Node => {
  if (node.type === "agent") {
    return {
      ...node,
      settings: {
        ...node.settings,
        instructions: prefixedText(node.settings.instructions, prefix),
      },
    };
  }
  if (node.type === "branch" && !decidedByValue(node.settings) && node.settings.variable !== "") {
    return {
      ...node,
      settings: { ...node.settings, variable: `${prefix}.${node.settings.variable}` },
    };
  }
  return node;
};

const withOverrides = (flow: Flow, overrides: Overrides): Flow => ({
  ...flow,
  containers: flow.containers.map((container) => {
    const override = overrides[container.id];
    if (!isSession(container) || override === undefined) return container;
    const { repo, branch, model } = override;
    return {
      ...container,
      ...(repo === undefined ? {} : { repo }),
      ...(branch === undefined ? {} : { branch }),
      ...(model === undefined ? {} : { model }),
    };
  }),
});

function splice(host: Flow, use: LibraryNode, library: Flow, prefix: string): Flow {
  const found = mainFlow(library);
  const part = mainFlowOnly(library);
  const start = canvasStart(part);
  const stops = canvasStops(part);
  const isEnd = (id: string) => id === start || stops.has(id);
  const members = part.nodes.filter((node) => !isEnd(node.id));
  const sessions = part.containers
    .filter(isSession)
    .filter((session) => found?.containers.has(session.id) === true);

  const taken = new Set([
    ...host.nodes.map((node) => node.id),
    ...host.containers.map(({ id }) => id),
  ]);
  const ids = new Map<string, string>();
  for (const id of [...members.map((node) => node.id), ...sessions.map((session) => session.id)]) {
    const free = firstFree(`${prefix}-${id}`, taken);
    taken.add(free);
    ids.set(id, free);
  }
  const rename = (id: string) => ids.get(id) ?? id;
  const connectionIds = new Set((host.connections ?? []).map(({ id }) => id));
  const connections = (part.connections ?? [])
    .filter(({ between }) => between.every((session) => ids.has(session)))
    .map((connection): Connection => {
      const id = firstFree(`${prefix}-${connection.id}`, connectionIds);
      connectionIds.add(id);
      const [first, second] = connection.between;
      return { id, between: [rename(first), rename(second)] };
    });
  const end = ({ node, port }: Wire["from"]) => ({ node: rename(node), port });

  const placed = members.map((node): Node => {
    const parent = node.parent === undefined ? use.parent : rename(node.parent);
    const moved = withPrefixedVariables({ ...node, id: rename(node.id) }, prefix);
    return parent === undefined ? moved : { ...moved, parent };
  });
  const topLevel = members
    .filter((node) => atCanvasLevel(part, node))
    .map((node) => rename(node.id));

  const into = host.wires.filter((wire) => wire.to.node === use.id);
  const outOf = host.wires.filter((wire) => wire.from.node === use.id);
  const spliced = part.wires.flatMap((wire): Wire[] => {
    const fromStart = wire.from.node === start;
    const toStop = stops.has(wire.to.node);
    if (fromStart && toStop) {
      return into.flatMap((entry) =>
        outOf.map((exit) => ({ ...wire, from: entry.from, to: exit.to })),
      );
    }
    if (fromStart) return into.map((entry) => ({ ...wire, from: entry.from, to: end(wire.to) }));
    if (toStop) return outOf.map((exit) => ({ ...wire, from: end(wire.from), to: exit.to }));
    return [{ ...wire, from: end(wire.from), to: end(wire.to) }];
  });

  return {
    ...host,
    nodes: [...host.nodes.filter((node) => node.id !== use.id), ...placed],
    wires: [
      ...host.wires.filter((wire) => wire.from.node !== use.id && wire.to.node !== use.id),
      ...spliced,
    ],
    containers: [
      ...host.containers.map((container) => ({
        ...container,
        nodes: container.nodes.flatMap((id) => (id === use.id ? topLevel : [id])),
      })),
      ...sessions.map((session) => ({
        ...session,
        id: rename(session.id),
        name: `${prefix}-${session.name}`,
        nodes: session.nodes.map(rename),
      })),
    ],
    ...(connections.length === 0
      ? {}
      : { connections: [...(host.connections ?? []), ...connections] }),
  };
}

function expandOne(
  host: Flow,
  use: LibraryNode,
  resolve: LibraryResolver,
  chain: readonly string[],
): Expanded {
  const { libraryId, label, overrides } = use.settings;
  if (chain.includes(libraryId)) {
    const [root = libraryId] = chain;
    const path = libraryLoop(
      (id) => {
        const used = resolve(id);
        return used && libraryUses(used.flow);
      },
      undefined,
      root,
    ) ?? [...chain.slice(chain.indexOf(libraryId)), libraryId];
    throw new LibraryLoopError(libraryLoopReason(root, path, (id) => resolve(id)?.name));
  }
  const library = resolve(libraryId);
  if (library === undefined) throw new LibraryError(`${label} names a library that does not exist`);
  const inner = expandWithin(library.flow, resolve, [...chain, libraryId]);
  const kind = blueprintKind(inner.flow);
  if (kind !== "node-library" && kind !== "session-library") {
    throw new LibraryError(
      `${label} names "${library.name}", which is not a node or session library`,
    );
  }
  const prefix = labelPrefix(label);
  return {
    flow: splice(host, use, withOverrides(inner.flow, overrides), prefix),
    uses: [
      { path: prefix, name: library.name, kind },
      ...inner.uses.map((nested) => ({ ...nested, path: `${prefix}.${nested.path}` })),
    ],
  };
}

function expandWithin(flow: Flow, resolve: LibraryResolver, chain: readonly string[]): Expanded {
  const reached = mainFlow(flow)?.reached ?? new Set<string>();
  return flow.nodes
    .filter((node): node is LibraryNode => node.type === "library" && reached.has(node.id))
    .reduce<Expanded>(
      (done, use) => {
        const next = expandOne(done.flow, use, resolve, chain);
        return { flow: next.flow, uses: [...done.uses, ...next.uses] };
      },
      { flow, uses: [] },
    );
}

export const expandLibraries = (flow: Flow, resolve: LibraryResolver): Expanded =>
  expandWithin(flow, resolve, []);

export const expandedOrAsIs = (flow: Flow, resolve: LibraryResolver): Expanded => {
  try {
    return expandLibraries(flow, resolve);
  } catch (error) {
    if (!(error instanceof LibraryError)) throw error;
    return { flow, uses: [] };
  }
};

export const reachedSessions = (flow: Flow): LibrarySession[] => {
  const reached = mainFlow(flow)?.containers ?? new Set<string>();
  return flow.containers
    .filter(
      (container): container is SessionContainer =>
        isSession(container) && reached.has(container.id),
    )
    .map(({ id, name, repo, branch, model }) => ({ id, name, repo, branch, model }));
};
