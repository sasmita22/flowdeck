import { MarkerType } from "@xyflow/react";
import { mainFlow } from "../../../core/flow/main-flow.js";
import type { CanvasNote, Flow, Node, Wire } from "../../../core/flow/schema.js";
import { nodeLook } from "../nodes/look.js";
import {
  bodyFrameBounds,
  boundsOf,
  containerMoves,
  followed,
  nodeSub,
  withPositions,
  type Bounds,
} from "./frames.js";
import { labelFor } from "./store.js";

export { FRAME_PADDING } from "./frames.js";

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
    sub?: string;
    name?: string;
    loopId?: string;
    forEachId?: string;
    text?: string;
    ignored?: boolean;
  };
}

export interface ViewEdge {
  id: string;
  source: string;
  sourceHandle: string;
  target: string;
  targetHandle: string;
  markerEnd: { type: MarkerType };
  selected?: boolean;
  type?: "aligned" | "branch";
  data?: { align: Align } | { label: string };
}

export type Align = "source" | "target";

type EdgeEnds = { sourceX: number; sourceY: number; targetX: number; targetY: number };

export const alignedEnds = <Ends extends EdgeEnds>(ends: Ends, align: Align): Ends =>
  align === "target" ? { ...ends, sourceY: ends.targetY } : { ...ends, targetY: ends.sourceY };

export const edgeId = (wire: Wire): string => {
  const { from, to } = wire;
  return `${from.node}:${from.port}->${to.node}:${to.port}`;
};

const isBarType = (type: Node["type"] | undefined) => type === "fork" || type === "join";

const isBar = (node: Node) => isBarType(node.type);

const branchesOf = (flow: Flow, bar: Node): Node[] => {
  const ids = new Set(
    flow.wires.flatMap(({ kind, from, to }) => {
      if (kind !== "then") return [];
      if (bar.type === "fork" && from.node === bar.id) return [to.node];
      if (bar.type === "join" && to.node === bar.id) return [from.node];
      return [];
    }),
  );
  return flow.nodes.filter((node) => ids.has(node.id));
};

const barBounds = (flow: Flow, bar: Node, x = bar.position.x): Bounds | null => {
  const branches = branchesOf(flow, bar)
    .filter((node) => !isBar(node))
    .map(boundsOf);
  if (branches.length === 0) return null;
  const { width, height } = nodeLook(bar.type).box;
  const top = Math.min(...branches.map((branch) => branch.top));
  return {
    left: x,
    top,
    right: x + width,
    bottom: Math.max(top + height, ...branches.map(({ bottom }) => bottom)),
  };
};

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

type IsIgnored = (id: string) => boolean;

const ignoredIn = (flow: Flow): IsIgnored => {
  const found = mainFlow(flow);
  if (found === undefined) return () => false;
  return (id) => !found.reached.has(id);
};

const toLoopFrameViewNodes = (flow: Flow, isIgnored: IsIgnored): ViewNode[] =>
  flow.nodes
    .filter((node) => node.type === "loop")
    .map((loop) =>
      frameView(`loop-frame-${loop.id}`, "loop-frame", bodyFrameBounds(flow, loop), {
        loopId: loop.id,
        ignored: isIgnored(loop.id),
      }),
    );

const toForEachFrameViewNodes = (flow: Flow, isIgnored: IsIgnored): ViewNode[] =>
  flow.nodes
    .filter((node) => node.type === "foreach")
    .map((each) =>
      frameView(`foreach-frame-${each.id}`, "foreach-frame", bodyFrameBounds(flow, each), {
        forEachId: each.id,
        ignored: isIgnored(each.id),
      }),
    );

const placed = (flow: Flow, node: Node, position: Position) => {
  if (!isBar(node)) return { position };
  const bar = barBounds(flow, node, position.x);
  if (bar === null) return { position, ...nodeLook(node.type).box };
  return {
    position: { x: bar.left, y: bar.top },
    width: bar.right - bar.left,
    height: bar.bottom - bar.top,
  };
};

type Box = { x: number; y: number; width: number; height: number };

const toNoteViewNode = (
  { id, text, position, size }: CanvasNote,
  selection: readonly string[],
  dragPosition: Position | undefined,
  live: Box | undefined,
): ViewNode => ({
  id,
  type: "note",
  position: live === undefined ? { ...(dragPosition ?? position) } : { x: live.x, y: live.y },
  width: live?.width ?? size.width,
  height: live?.height ?? size.height,
  selected: selection.includes(id),
  data: { text },
});

export const toViewNodes = (
  flow: Flow,
  selection: readonly string[],
  dragPositions: Readonly<Record<string, Position>>,
  highlighted: string | null,
  noteBoxes: Readonly<Record<string, Box>> = {},
): ViewNode[] => {
  const live = withPositions(flow, followed(flow, dragPositions));
  const framing = withPositions(flow, containerMoves(flow, dragPositions));
  const isIgnored = ignoredIn(flow);
  return [
    ...toLoopFrameViewNodes(framing, isIgnored),
    ...toForEachFrameViewNodes(framing, isIgnored),
    ...(flow.notes ?? []).map((note) =>
      toNoteViewNode(note, selection, dragPositions[note.id], noteBoxes[note.id]),
    ),
    ...live.nodes.map((node) => {
      const sub = nodeSub(node);
      return {
        id: node.id,
        type: node.type,
        ...placed(framing, node, node.position),
        selected: selection.includes(node.id),
        data: {
          label: labelFor(node),
          highlighted: node.id === highlighted,
          ignored: isIgnored(node.id),
          ...(sub !== undefined && { sub }),
        },
      };
    }),
  ];
};

const alignOf = (types: ReadonlyMap<string, Node["type"]>, wire: Wire): Align | null => {
  if (isBarType(types.get(wire.from.node)) && isBarType(types.get(wire.to.node))) return null;
  if (types.get(wire.from.node) === "fork") return "target";
  if (types.get(wire.to.node) === "join") return "source";
  return null;
};

export const toViewEdges = (flow: Flow, selected: readonly string[] = []): ViewEdge[] => {
  const types = new Map(flow.nodes.map((node) => [node.id, node.type]));
  return flow.wires.map((wire) => {
    const align = alignOf(types, wire);
    const id = edgeId(wire);
    const fromBranch = types.get(wire.from.node) === "branch";
    const isSelected = selected.includes(id);
    return {
      id,
      source: wire.from.node,
      sourceHandle: wire.from.port,
      target: wire.to.node,
      targetHandle: wire.to.port,
      markerEnd: {
        type: MarkerType.ArrowClosed,
        ...(isSelected && { color: "var(--select)" }),
      },
      ...(align !== null && { type: "aligned" as const, data: { align } }),
      ...(fromBranch && { type: "branch" as const, data: { label: wire.from.port } }),
      ...(isSelected && { selected: true }),
    };
  });
};
