import type {
  CanvasNote,
  Connection,
  Flow,
  FlowContainer,
  FlowSettings,
  Node,
  SessionContainer,
  Wire,
} from "../../../core/flow/schema.js";
import { flowContainerMembers } from "../../../core/flow/structure.js";

export interface Command {
  do(flow: Flow): Flow;
  undo(flow: Flow): Flow;
}

type Position = { x: number; y: number };

type Indexed<T> = { index: number; item: T };

const indexed = <T>(items: readonly T[], keep: (item: T, index: number) => boolean): Indexed<T>[] =>
  items.flatMap((item, index) => (keep(item, index) ? [{ index, item }] : []));

const reinsert = <T>(items: readonly T[], removed: readonly Indexed<T>[]): T[] => {
  const result = [...items];
  for (const { index, item } of removed) result.splice(index, 0, item);
  return result;
};

const without = <T>(items: readonly T[], removed: readonly Indexed<T>[]): T[] => {
  const indexes = new Set(removed.map(({ index }) => index));
  return items.filter((_item, index) => !indexes.has(index));
};

const withNotes = (flow: Flow, notes: readonly CanvasNote[]): Flow => {
  if (notes.length > 0) return { ...flow, notes: [...notes] };
  const rest = { ...flow };
  delete rest.notes;
  return rest;
};

const notesOf = (flow: Flow): readonly CanvasNote[] => flow.notes ?? [];

const withConnections = (flow: Flow, connections: readonly Connection[]): Flow => {
  if (connections.length > 0) return { ...flow, connections: [...connections] };
  const rest = { ...flow };
  delete rest.connections;
  return rest;
};

const connectionsOf = (flow: Flow): readonly Connection[] => flow.connections ?? [];

const touching = (flow: Flow, removed: ReadonlySet<string>): Indexed<Connection>[] =>
  indexed(connectionsOf(flow), ({ between }) => between.some((end) => removed.has(end)));

const withMember = (flow: Flow, containerId: string | undefined, id: string, join: boolean) =>
  containerId === undefined
    ? flow.containers
    : flow.containers.map((container) =>
        container.id !== containerId
          ? container
          : {
              ...container,
              nodes: join
                ? [...container.nodes, id]
                : container.nodes.filter((member) => member !== id),
            },
      );

export const addNode = (node: Node, container?: string): Command => ({
  do: (flow) => ({
    ...flow,
    nodes: [...flow.nodes, node],
    containers: withMember(flow, container, node.id, true),
  }),
  undo: (flow) => ({
    ...flow,
    nodes: flow.nodes.slice(0, -1),
    containers: withMember(flow, container, node.id, false),
  }),
});

export const addWire = (wire: Wire): Command => ({
  do: (flow) => ({ ...flow, wires: [...flow.wires, wire] }),
  undo: (flow) => ({ ...flow, wires: flow.wires.slice(0, -1) }),
});

export const addConnection = (connection: Connection): Command => ({
  do: (flow) => withConnections(flow, [...connectionsOf(flow), connection]),
  undo: (flow) => withConnections(flow, connectionsOf(flow).slice(0, -1)),
});

export const deleteConnections = (flow: Flow, ids: readonly string[]): Command => {
  const doomed = new Set(ids);
  const connections = indexed(connectionsOf(flow), ({ id }) => doomed.has(id));
  return {
    do: (current) => withConnections(current, without(connectionsOf(current), connections)),
    undo: (current) => withConnections(current, reinsert(connectionsOf(current), connections)),
  };
};

export const addNote = (note: CanvasNote): Command => ({
  do: (flow) => withNotes(flow, [...notesOf(flow), note]),
  undo: (flow) => withNotes(flow, notesOf(flow).slice(0, -1)),
});

export const updateNote = (next: CanvasNote): Command => {
  let previous: CanvasNote | undefined;
  const replace = (flow: Flow, note: CanvasNote | undefined): Flow =>
    note === undefined
      ? flow
      : withNotes(
          flow,
          notesOf(flow).map((current) => (current.id === note.id ? note : current)),
        );
  return {
    do: (flow) => {
      previous = notesOf(flow).find((note) => note.id === next.id);
      return previous === undefined ? flow : replace(flow, next);
    },
    undo: (flow) => replace(flow, previous),
  };
};

type ContainerRemoval = {
  containers: Indexed<FlowContainer>[];
  members: Map<string, Indexed<string>[]>;
};

const containerRemoval = (
  containers: readonly FlowContainer[],
  doomed: ReadonlySet<string>,
  dropped: ReadonlySet<string> = new Set(),
): ContainerRemoval => {
  const emptied = (container: FlowContainer) =>
    dropped.has(container.id) ||
    (container.nodes.length > 0 && container.nodes.every((id) => doomed.has(id)));
  return {
    containers: indexed(containers, emptied),
    members: new Map(
      containers.map((container) => [
        container.id,
        indexed(container.nodes, (id) => doomed.has(id)),
      ]),
    ),
  };
};

const membersOf = (removal: ContainerRemoval, container: FlowContainer) =>
  removal.members.get(container.id) ?? [];

const removeContainers = (containers: readonly FlowContainer[], removal: ContainerRemoval) =>
  without(containers, removal.containers).map((container) => ({
    ...container,
    nodes: without(container.nodes, membersOf(removal, container)),
  }));

const restoreContainers = (containers: readonly FlowContainer[], removal: ContainerRemoval) =>
  reinsert(
    containers.map((container) => ({
      ...container,
      nodes: reinsert(container.nodes, membersOf(removal, container)),
    })),
    removal.containers,
  );

const deleting = (flow: Flow, ids: readonly string[], dropped?: ReadonlySet<string>): Command => {
  const doomed = new Set(ids);
  const nodes = indexed(flow.nodes, (node) => doomed.has(node.id));
  const notes = indexed(notesOf(flow), (note) => doomed.has(note.id));
  const wires = indexed(
    flow.wires,
    (wire) => doomed.has(wire.from.node) || doomed.has(wire.to.node),
  );
  const containers = containerRemoval(flow.containers, doomed, dropped);
  const connections = touching(flow, new Set(containers.containers.map(({ item }) => item.id)));
  return {
    do: (current) =>
      withConnections(
        withNotes(
          {
            ...current,
            nodes: without(current.nodes, nodes),
            wires: without(current.wires, wires),
            containers: removeContainers(current.containers, containers),
          },
          without(notesOf(current), notes),
        ),
        without(connectionsOf(current), connections),
      ),
    undo: (current) =>
      withConnections(
        withNotes(
          {
            ...current,
            nodes: reinsert(current.nodes, nodes),
            wires: reinsert(current.wires, wires),
            containers: restoreContainers(current.containers, containers),
          },
          reinsert(notesOf(current), notes),
        ),
        reinsert(connectionsOf(current), connections),
      ),
  };
};

export const deleteNodes = (flow: Flow, ids: readonly string[]): Command => deleting(flow, ids);

export const deleteFlowContainer = (flow: Flow, id: string): Command =>
  flow.containers.some((container) => container.id === id)
    ? deleting(flow, flowContainerMembers(flow, id), new Set([id]))
    : { do: (current) => current, undo: (current) => current };

export const deleteWires = (flow: Flow, indexes: readonly number[]): Command => {
  const places = new Set(indexes);
  const wires = indexed(flow.wires, (_wire, index) => places.has(index));
  return {
    do: (current) => ({ ...current, wires: without(current.wires, wires) }),
    undo: (current) => ({ ...current, wires: reinsert(current.wires, wires) }),
  };
};

export type Items = {
  nodes: readonly Node[];
  wires: readonly Wire[];
  notes: readonly CanvasNote[];
  containers?: readonly FlowContainer[];
  members?: Readonly<Record<string, string>>;
};

const withMembers = (flow: Flow, members: Readonly<Record<string, string>>, join: boolean) =>
  Object.entries(members).reduce(
    (current, [id, container]) => ({
      ...current,
      containers: withMember(current, container, id, join),
    }),
    flow,
  ).containers;

export const addItems = (items: Items): Command => {
  const containers = items.containers ?? [];
  const members = items.members ?? {};
  return {
    do: (flow) =>
      withNotes(
        {
          ...flow,
          nodes: [...flow.nodes, ...items.nodes],
          wires: [...flow.wires, ...items.wires],
          containers: withMembers(
            { ...flow, containers: [...flow.containers, ...containers] },
            members,
            true,
          ),
        },
        [...notesOf(flow), ...items.notes],
      ),
    undo: (flow) =>
      withNotes(
        {
          ...flow,
          nodes: flow.nodes.slice(0, flow.nodes.length - items.nodes.length),
          wires: flow.wires.slice(0, flow.wires.length - items.wires.length),
          containers: withMembers(flow, members, false).slice(
            0,
            flow.containers.length - containers.length,
          ),
        },
        notesOf(flow).slice(0, notesOf(flow).length - items.notes.length),
      ),
  };
};

export type Move = {
  id: string;
  from: Position;
  to: Position;
  parent?: { from: string | undefined; to: string | undefined };
  container?: { from: string | undefined; to: string | undefined };
};

const withParent = (node: Node, parent: string | undefined): Node => {
  if (parent !== undefined) return { ...node, parent };
  const rest = { ...node };
  delete rest.parent;
  return rest;
};

const placeAt =
  (moves: readonly Move[], side: "from" | "to") =>
  (flow: Flow): Flow => {
    const byId = new Map(moves.map((move) => [move.id, move]));
    const place = <T extends { id: string; position: Position }>(item: T): T => {
      const move = byId.get(item.id);
      return move === undefined ? item : { ...item, position: { ...move[side] } };
    };
    const nest = (node: Node): Node => {
      const parent = byId.get(node.id)?.parent;
      return parent === undefined ? node : withParent(node, parent[side]);
    };
    return withNotes(
      { ...flow, nodes: flow.nodes.map((node) => nest(place(node))) },
      notesOf(flow).map(place),
    );
  };

const rehome = (containers: readonly FlowContainer[], moves: readonly Move[]): FlowContainer[] => {
  const carried = moves.flatMap(({ id, container }) =>
    container === undefined || container.from === container.to ? [] : [{ id, ...container }],
  );
  const leaving = new Set(carried.map(({ id }) => id));
  const joining = (containerId: string) =>
    carried.filter(({ to }) => to === containerId).map(({ id }) => id);
  return containers.flatMap((container) => {
    const kept = container.nodes.filter((id) => !leaving.has(id));
    const nodes = [...kept, ...joining(container.id)];
    return nodes.length === 0 && container.nodes.length > 0 ? [] : [{ ...container, nodes }];
  });
};

export const moveNodes = (moves: readonly Move[]): Command => {
  let previous: readonly FlowContainer[] | undefined;
  let dropped: Indexed<Connection>[] = [];
  return {
    do: (flow) => {
      previous = flow.containers;
      const containers = rehome(flow.containers, moves);
      const kept = new Set(containers.map(({ id }) => id));
      dropped = touching(
        flow,
        new Set(flow.containers.map(({ id }) => id).filter((id) => !kept.has(id))),
      );
      return withConnections(
        { ...placeAt(moves, "to")(flow), containers },
        without(connectionsOf(flow), dropped),
      );
    },
    undo: (flow) =>
      withConnections(
        { ...placeAt(moves, "from")(flow), containers: [...(previous ?? flow.containers)] },
        reinsert(connectionsOf(flow), dropped),
      ),
  };
};

export type FlowContainerPatch = Partial<
  Pick<SessionContainer, "name" | "repo" | "branch" | "model">
>;

const patched = (container: FlowContainer, patch: FlowContainerPatch): FlowContainer => {
  if (container.kind === "workspace") {
    return patch.model === undefined ? container : { ...container, model: patch.model };
  }
  const movedRepo = patch.repo !== undefined && patch.repo !== container.repo;
  return {
    ...container,
    ...patch,
    ...(movedRepo && patch.branch === undefined ? { branch: "" } : {}),
  };
};

export const updateFlowContainer = (id: string, patch: FlowContainerPatch): Command => {
  let previous: FlowContainer | undefined;
  const replace = (flow: Flow, next: (container: FlowContainer) => FlowContainer): Flow => ({
    ...flow,
    containers: flow.containers.map((container) =>
      container.id === id ? next(container) : container,
    ),
  });
  return {
    do: (flow) => {
      previous = flow.containers.find((container) => container.id === id);
      return previous === undefined
        ? flow
        : replace(flow, (container) => patched(container, patch));
    },
    undo: (flow) => {
      const restored = previous;
      return restored === undefined ? flow : replace(flow, () => restored);
    },
  };
};

const withSettings = (flow: Flow, settings: FlowSettings): Flow => ({ ...flow, settings });

export const updateSettings = (next: FlowSettings): Command => {
  let previous: FlowSettings | undefined;
  return {
    do: (flow) => {
      previous = flow.settings;
      return withSettings(flow, next);
    },
    undo: (flow) => (previous === undefined ? flow : withSettings(flow, previous)),
  };
};

export const updateNode = (next: Node): Command => {
  let previous: Node | undefined;
  const replace = (flow: Flow, node: Node | undefined): Flow =>
    node === undefined
      ? flow
      : { ...flow, nodes: flow.nodes.map((current) => (current.id === node.id ? node : current)) };
  return {
    do: (flow) => {
      previous = flow.nodes.find((node) => node.id === next.id);
      return previous === undefined ? flow : replace(flow, next);
    },
    undo: (flow) => replace(flow, previous),
  };
};
