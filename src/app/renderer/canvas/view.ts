import type { Flow, Wire } from "../../../core/flow/schema.js";

type Position = { x: number; y: number };

export interface ViewNode {
  id: string;
  type: string;
  position: Position;
  selected: boolean;
  data: { label: string };
}

export interface ViewEdge {
  id: string;
  source: string;
  sourceHandle: string;
  target: string;
  targetHandle: string;
}

export const edgeId = ({ from, to }: Wire): string =>
  `${from.node}:${from.port}->${to.node}:${to.port}`;

export const toViewNodes = (
  flow: Flow,
  selection: readonly string[],
  dragPositions: Readonly<Record<string, Position>>,
): ViewNode[] =>
  flow.nodes.map((node) => ({
    id: node.id,
    type: node.type,
    position: dragPositions[node.id] ?? node.position,
    selected: selection.includes(node.id),
    data: { label: node.label },
  }));

export const toViewEdges = (flow: Flow): ViewEdge[] =>
  flow.wires.map((wire) => ({
    id: edgeId(wire),
    source: wire.from.node,
    sourceHandle: wire.from.port,
    target: wire.to.node,
    targetHandle: wire.to.port,
  }));
