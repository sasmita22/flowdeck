import type { CanvasNote, Flow, Node, Session, Wire } from "../../../core/flow/schema.js";

export interface Command {
  do(flow: Flow): Flow;
  undo(flow: Flow): Flow;
}

type Position = { x: number; y: number };

type Indexed<T> = { index: number; item: T };

const indexed = <T>(items: readonly T[], keep: (item: T) => boolean): Indexed<T>[] =>
  items.flatMap((item, index) => (keep(item) ? [{ index, item }] : []));

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

export const addNode = (node: Node): Command => ({
  do: (flow) => ({ ...flow, nodes: [...flow.nodes, node] }),
  undo: (flow) => ({ ...flow, nodes: flow.nodes.slice(0, -1) }),
});

export const addWire = (wire: Wire): Command => ({
  do: (flow) => ({ ...flow, wires: [...flow.wires, wire] }),
  undo: (flow) => ({ ...flow, wires: flow.wires.slice(0, -1) }),
});

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

export const deleteNodes = (flow: Flow, ids: readonly string[]): Command => {
  const doomed = new Set(ids);
  const nodes = indexed(flow.nodes, (node) => doomed.has(node.id));
  const notes = indexed(notesOf(flow), (note) => doomed.has(note.id));
  const wires = indexed(
    flow.wires,
    (wire) => doomed.has(wire.from.node) || doomed.has(wire.to.node),
  );
  return {
    do: (current) =>
      withNotes(
        { ...current, nodes: without(current.nodes, nodes), wires: without(current.wires, wires) },
        without(notesOf(current), notes),
      ),
    undo: (current) =>
      withNotes(
        {
          ...current,
          nodes: reinsert(current.nodes, nodes),
          wires: reinsert(current.wires, wires),
        },
        reinsert(notesOf(current), notes),
      ),
  };
};

export type Move = {
  id: string;
  from: Position;
  to: Position;
  parent?: { from: string | undefined; to: string | undefined };
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

export const moveNodes = (moves: readonly Move[]): Command => ({
  do: placeAt(moves, "to"),
  undo: placeAt(moves, "from"),
});

const withSession = (flow: Flow, session: Session): Flow => ({ ...flow, session });

export const wrappableIds = (flow: Flow, ids: readonly string[]): string[] => {
  const members = new Set(flow.session.frame?.nodes);
  const topLevel = new Set(
    flow.nodes.filter((node) => node.parent === undefined).map((node) => node.id),
  );
  return ids.filter((id) => topLevel.has(id) && !members.has(id));
};

export const wrapInSession = (ids: readonly string[]): Command => {
  let previous: Session | undefined;
  return {
    do: (flow) => {
      const added = wrappableIds(flow, ids);
      if (added.length === 0) return flow;
      previous = flow.session;
      return withSession(flow, {
        ...flow.session,
        frame: { nodes: [...(flow.session.frame?.nodes ?? []), ...added] },
      });
    },
    undo: (flow) => (previous === undefined ? flow : withSession(flow, previous)),
  };
};

export const updateSession = (next: Session): Command => {
  let previous: Session | undefined;
  return {
    do: (flow) => {
      previous = flow.session;
      return withSession(flow, next);
    },
    undo: (flow) => (previous === undefined ? flow : withSession(flow, previous)),
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
