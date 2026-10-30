import type { Flow, Node, Wire } from "../../../core/flow/schema.js";
import { nodeLook } from "../nodes/look.js";

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
  data: { label?: string; highlighted?: boolean; name?: string; loopId?: string };
}

export const SESSION_FRAME_ID = "session-frame";
export const FRAME_PADDING = 24;

export interface ViewEdge {
  id: string;
  source: string;
  sourceHandle: string;
  target: string;
  targetHandle: string;
}

export const edgeId = ({ from, to }: Wire): string =>
  `${from.node}:${from.port}->${to.node}:${to.port}`;

type Bounds = { left: number; top: number; right: number; bottom: number };

const boundsOf = ({ type, position: { x, y } }: Node): Bounds => {
  const { width, height } = nodeLook(type).box;
  return { left: x, top: y, right: x + width, bottom: y + height };
};

const padded = (all: readonly Bounds[]): Bounds => ({
  left: Math.min(...all.map(({ left }) => left)) - FRAME_PADDING,
  top: Math.min(...all.map(({ top }) => top)) - FRAME_PADDING,
  right: Math.max(...all.map(({ right }) => right)) + FRAME_PADDING,
  bottom: Math.max(...all.map(({ bottom }) => bottom)) + FRAME_PADDING,
});

const loopFrameBounds = (flow: Flow, loop: Node): Bounds =>
  padded([loop, ...flow.nodes.filter((node) => node.parent === loop.id)].map(boundsOf));

const frameView = (
  id: string,
  type: string,
  { left, top, right, bottom }: Bounds,
  data: ViewNode["data"],
): ViewNode => ({
  id,
  type,
  position: { x: left, y: top },
  width: right - left,
  height: bottom - top,
  selectable: false,
  draggable: false,
  deletable: false,
  data,
});

const frameMembers = (flow: Flow): Flow["nodes"] => {
  const members = new Set(flow.session.frame?.nodes);
  return flow.nodes.filter(
    (node) => members.has(node.id) || (node.parent !== undefined && members.has(node.parent)),
  );
};

const toFrameViewNode = (flow: Flow): ViewNode[] => {
  const bounds = frameMembers(flow).map((node) =>
    node.type === "loop" ? loopFrameBounds(flow, node) : boundsOf(node),
  );
  if (bounds.length === 0) return [];
  return [frameView(SESSION_FRAME_ID, "session", padded(bounds), { name: flow.session.name })];
};

const toLoopFrameViewNodes = (flow: Flow): ViewNode[] =>
  flow.nodes
    .filter((node) => node.type === "loop")
    .map((loop) =>
      frameView(`loop-frame-${loop.id}`, "loop-frame", loopFrameBounds(flow, loop), {
        loopId: loop.id,
      }),
    );

export const toViewNodes = (
  flow: Flow,
  selection: readonly string[],
  dragPositions: Readonly<Record<string, Position>>,
  highlighted: string | null,
): ViewNode[] => [
  ...toFrameViewNode(flow),
  ...toLoopFrameViewNodes(flow),
  ...flow.nodes.map((node) => ({
    id: node.id,
    type: node.type,
    position: dragPositions[node.id] ?? node.position,
    selected: selection.includes(node.id),
    ...(node.type === "hardstop" && { deletable: false }),
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
