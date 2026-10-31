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
  data: {
    label?: string;
    highlighted?: boolean;
    name?: string;
    loopId?: string;
    forEachId?: string;
  };
}

export const SESSION_FRAME_ID = "session-frame";
export const FRAME_PADDING = 24;

export interface ViewEdge {
  id: string;
  source: string;
  sourceHandle: string;
  target: string;
  targetHandle: string;
  type?: "aligned";
  data?: { align: Align };
}

export type Align = "source" | "target";

type EdgeEnds = { sourceX: number; sourceY: number; targetX: number; targetY: number };

export const alignedEnds = <Ends extends EdgeEnds>(ends: Ends, align: Align): Ends =>
  align === "target" ? { ...ends, sourceY: ends.targetY } : { ...ends, targetY: ends.sourceY };

export const edgeId = ({ from, to }: Wire): string =>
  `${from.node}:${from.port}->${to.node}:${to.port}`;

type Bounds = { left: number; top: number; right: number; bottom: number };

const boundsOf = ({ type, position: { x, y } }: Node): Bounds => {
  const { width, height } = nodeLook(type).box;
  return { left: x, top: y, right: x + width, bottom: y + height };
};

const branchesOf = (flow: Flow, bar: Node): Node[] => {
  const ids = new Set(
    flow.wires.flatMap(({ from, to }) => {
      if (bar.type === "fork" && from.node === bar.id) return [to.node];
      if (bar.type === "join" && to.node === bar.id) return [from.node];
      return [];
    }),
  );
  return flow.nodes.filter((node) => ids.has(node.id));
};

const barBounds = (flow: Flow, bar: Node, x = bar.position.x): Bounds | null => {
  const branches = branchesOf(flow, bar).map(boundsOf);
  if (branches.length === 0) return null;
  return {
    left: x,
    top: Math.min(...branches.map(({ top }) => top)),
    right: x + nodeLook(bar.type).box.width,
    bottom: Math.max(...branches.map(({ bottom }) => bottom)),
  };
};

const padded = (all: readonly Bounds[]): Bounds => ({
  left: Math.min(...all.map(({ left }) => left)) - FRAME_PADDING,
  top: Math.min(...all.map(({ top }) => top)) - FRAME_PADDING,
  right: Math.max(...all.map(({ right }) => right)) + FRAME_PADDING,
  bottom: Math.max(...all.map(({ bottom }) => bottom)) + FRAME_PADDING,
});

const bodyFrameBounds = (flow: Flow, scope: Node): Bounds =>
  padded([scope, ...flow.nodes.filter((node) => node.parent === scope.id)].map(boundsOf));

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
    node.type === "loop" || node.type === "foreach"
      ? bodyFrameBounds(flow, node)
      : (barBounds(flow, node) ?? boundsOf(node)),
  );
  if (bounds.length === 0) return [];
  return [frameView(SESSION_FRAME_ID, "session", padded(bounds), { name: flow.session.name })];
};

const toLoopFrameViewNodes = (flow: Flow): ViewNode[] =>
  flow.nodes
    .filter((node) => node.type === "loop")
    .map((loop) =>
      frameView(`loop-frame-${loop.id}`, "loop-frame", bodyFrameBounds(flow, loop), {
        loopId: loop.id,
      }),
    );

const toForEachFrameViewNodes = (flow: Flow): ViewNode[] =>
  flow.nodes
    .filter((node) => node.type === "foreach")
    .map((each) =>
      frameView(`foreach-frame-${each.id}`, "foreach-frame", bodyFrameBounds(flow, each), {
        forEachId: each.id,
      }),
    );

const placed = (flow: Flow, node: Node, position: Position) => {
  const bar = barBounds(flow, node, position.x);
  if (bar === null) return { position };
  return {
    position: { x: bar.left, y: bar.top },
    width: bar.right - bar.left,
    height: bar.bottom - bar.top,
  };
};

export const toViewNodes = (
  flow: Flow,
  selection: readonly string[],
  dragPositions: Readonly<Record<string, Position>>,
  highlighted: string | null,
): ViewNode[] => [
  ...toFrameViewNode(flow),
  ...toLoopFrameViewNodes(flow),
  ...toForEachFrameViewNodes(flow),
  ...flow.nodes.map((node) => ({
    id: node.id,
    type: node.type,
    ...placed(flow, node, dragPositions[node.id] ?? node.position),
    selected: selection.includes(node.id),
    ...(node.type === "hardstop" && { deletable: false }),
    data: { label: node.label, highlighted: node.id === highlighted },
  })),
];

const alignOf = (types: ReadonlyMap<string, Node["type"]>, wire: Wire): Align | null => {
  if (types.get(wire.from.node) === "fork") return "target";
  if (types.get(wire.to.node) === "join") return "source";
  return null;
};

export const toViewEdges = (flow: Flow): ViewEdge[] => {
  const types = new Map(flow.nodes.map((node) => [node.id, node.type]));
  return flow.wires.map((wire) => {
    const align = alignOf(types, wire);
    return {
      id: edgeId(wire),
      source: wire.from.node,
      sourceHandle: wire.from.port,
      target: wire.to.node,
      targetHandle: wire.to.port,
      ...(align !== null && { type: "aligned" as const, data: { align } }),
    };
  });
};
