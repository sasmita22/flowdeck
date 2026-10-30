import type { Flow, Node, Session, Wire } from "../../../core/flow/schema.js";

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

export const addNode = (node: Node): Command => ({
  do: (flow) => ({ ...flow, nodes: [...flow.nodes, node] }),
  undo: (flow) => ({ ...flow, nodes: flow.nodes.slice(0, -1) }),
});

export const addWire = (wire: Wire): Command => ({
  do: (flow) => ({ ...flow, wires: [...flow.wires, wire] }),
  undo: (flow) => ({ ...flow, wires: flow.wires.slice(0, -1) }),
});

export const deleteNodes = (flow: Flow, ids: readonly string[]): Command => {
  const doomed = new Set(ids);
  const nodes = indexed(flow.nodes, (node) => doomed.has(node.id));
  const wires = indexed(
    flow.wires,
    (wire) => doomed.has(wire.from.node) || doomed.has(wire.to.node),
  );
  return {
    do: (current) => ({
      ...current,
      nodes: without(current.nodes, nodes),
      wires: without(current.wires, wires),
    }),
    undo: (current) => ({
      ...current,
      nodes: reinsert(current.nodes, nodes),
      wires: reinsert(current.wires, wires),
    }),
  };
};

export type Move = { id: string; from: Position; to: Position };

const placeAt =
  (moves: readonly Move[], pick: (move: Move) => Position) =>
  (flow: Flow): Flow => {
    const targets = new Map(moves.map((move) => [move.id, pick(move)]));
    return {
      ...flow,
      nodes: flow.nodes.map((node) => {
        const position = targets.get(node.id);
        return position === undefined ? node : { ...node, position: { ...position } };
      }),
    };
  };

export const moveNodes = (moves: readonly Move[]): Command => ({
  do: placeAt(moves, (move) => move.to),
  undo: placeAt(moves, (move) => move.from),
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
