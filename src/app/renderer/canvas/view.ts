import type { Flow, Wire } from "../../../core/flow/schema.js";

type Position = { x: number; y: number };

export interface ViewNode {
  id: string;
  type: string;
  position: Position;
  selected?: boolean;
  width?: number;
  height?: number;
  selectable?: boolean;
  draggable?: boolean;
  deletable?: boolean;
  data: { label?: string; highlighted?: boolean; name?: string };
}

export const SESSION_FRAME_ID = "session-frame";
export const FRAME_PADDING = 24;
export const NODE_BOX = { width: 160, height: 56 };

export interface ViewEdge {
  id: string;
  source: string;
  sourceHandle: string;
  target: string;
  targetHandle: string;
}

export const edgeId = ({ from, to }: Wire): string =>
  `${from.node}:${from.port}->${to.node}:${to.port}`;

const frameMembers = (flow: Flow): Flow["nodes"] => {
  const members = new Set(flow.session.frame?.nodes);
  return flow.nodes.filter(
    (node) => members.has(node.id) || (node.parent !== undefined && members.has(node.parent)),
  );
};

const toFrameViewNode = (flow: Flow): ViewNode[] => {
  const positions = frameMembers(flow).map((node) => node.position);
  if (positions.length === 0) return [];
  const left = Math.min(...positions.map(({ x }) => x)) - FRAME_PADDING;
  const top = Math.min(...positions.map(({ y }) => y)) - FRAME_PADDING;
  const right = Math.max(...positions.map(({ x }) => x)) + NODE_BOX.width + FRAME_PADDING;
  const bottom = Math.max(...positions.map(({ y }) => y)) + NODE_BOX.height + FRAME_PADDING;
  return [
    {
      id: SESSION_FRAME_ID,
      type: "session",
      position: { x: left, y: top },
      width: right - left,
      height: bottom - top,
      selectable: false,
      draggable: false,
      deletable: false,
      data: { name: flow.session.name },
    },
  ];
};

export const toViewNodes = (
  flow: Flow,
  selection: readonly string[],
  dragPositions: Readonly<Record<string, Position>>,
  highlighted: string | null,
): ViewNode[] => [
  ...toFrameViewNode(flow),
  ...flow.nodes.map((node) => ({
    id: node.id,
    type: node.type,
    position: dragPositions[node.id] ?? node.position,
    selected: selection.includes(node.id),
    data: { label: node.label, highlighted: node.id === highlighted },
  })),
];

export const toViewEdges = (flow: Flow): ViewEdge[] =>
  flow.wires.map((wire) => ({
    id: edgeId(wire),
    source: wire.from.node,
    sourceHandle: wire.from.port,
    target: wire.to.node,
    targetHandle: wire.to.port,
  }));
