import { MarkerType } from "@xyflow/react";
import type { LibraryLookup } from "../../../core/flow/libraries.js";
import { mainFlow } from "../../../core/flow/main-flow.js";
import type { CanvasNote, Flow, FlowContainer, Node, Wire } from "../../../core/flow/schema.js";
import { flowContainerOf } from "../../../core/flow/structure.js";
import { nodeLook } from "../nodes/look.js";
import {
  bodyFrameBounds,
  boundsOf,
  containerMoves,
  flowContainerBounds,
  flowContainerMoves,
  followed,
  isContainer,
  labelledBounds,
  nodeSub,
  withPositions,
  type Bounds,
} from "./frames.js";
import {
  bezierCrosses,
  branchStub,
  clearOfEnds,
  goesBack,
  leavesRow,
  ROUTE_MARGIN,
  routeAroundRows,
  routeWire,
  wireEnds,
  type Point,
} from "../../../core/flow/wire-router.js";
import { textSpan } from "./wire-route.js";
import { labelFor } from "../../../core/nodes/defaults.js";

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
  zIndex?: number;
  data: {
    label?: string;
    highlighted?: boolean;
    sub?: string;
    name?: string;
    loopId?: string;
    forEachId?: string;
    containerId?: string;
    session?: boolean;
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
  markerStart?: { type: MarkerType };
  style?: { strokeDasharray: string };
  selected?: boolean;
  type?: "aligned" | "branch" | "connection" | "routed";
  data?: { align: Align } | { label: string } | { points: Point[]; label?: string };
}

export type Align = "source" | "target";

export const connectionPorts = { source: "session-out", target: "session-in" } as const;

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

type Ignoring = { node: IsIgnored; container: IsIgnored };

const ignoredIn = (flow: Flow, libraries?: LibraryLookup): Ignoring => {
  const found = mainFlow(flow, libraries);
  if (found === undefined) return { node: () => false, container: () => false };
  return { node: (id) => !found.reached.has(id), container: (id) => !found.containers.has(id) };
};

const toLoopFrameViewNodes = (flow: Flow, isIgnored: IsIgnored): ViewNode[] =>
  flow.nodes
    .filter((node) => node.type === "loop")
    .map((loop) =>
      frameView(`${loopFramePrefix}${loop.id}`, "loop-frame", bodyFrameBounds(flow, loop), {
        loopId: loop.id,
        ignored: isIgnored(loop.id),
      }),
    );

const toForEachFrameViewNodes = (flow: Flow, isIgnored: IsIgnored): ViewNode[] =>
  flow.nodes
    .filter((node) => node.type === "foreach")
    .map((each) =>
      frameView(`${forEachFramePrefix}${each.id}`, "foreach-frame", bodyFrameBounds(flow, each), {
        forEachId: each.id,
        ignored: isIgnored(each.id),
      }),
    );

const behindSelectedNodes = -1000;

const framePrefix = "container-frame-";

const loopFramePrefix = "loop-frame-";

const forEachFramePrefix = "foreach-frame-";

const containerFrameId = (id: string) => `${framePrefix}${id}`;

export const containerOfFrameId = (nodeId: string): string | undefined =>
  nodeId.startsWith(framePrefix) ? nodeId.slice(framePrefix.length) : undefined;

export const frameOwnerId = (viewId: string): string | undefined => {
  const prefix = [framePrefix, loopFramePrefix, forEachFramePrefix].find((each) =>
    viewId.startsWith(each),
  );
  return prefix === undefined ? undefined : viewId.slice(prefix.length);
};

export const frameDragMoves = (
  flow: Flow,
  dragPositions: Readonly<Record<string, Position>>,
): Record<string, Position> =>
  Object.assign(
    {},
    ...Object.entries(dragPositions).map(([id, to]) => {
      const container = containerOfFrameId(id);
      return container === undefined ? {} : flowContainerMoves(flow, container, to);
    }),
  ) as Record<string, Position>;

const hasFrame = (container: FlowContainer) => container.nodes.length > 0;

type End = { node: string; port: string };

export type ConnectionRoute =
  { kind: "sessions"; from: string; to: string } | { kind: "wire"; from: End; to: End };

type Drag = {
  source: string;
  sourceHandle: string | null;
  target: string;
  targetHandle: string | null;
};

export const routeConnection = ({
  source,
  sourceHandle,
  target,
  targetHandle,
}: Drag): ConnectionRoute | null => {
  if (sourceHandle === null || targetHandle === null) return null;
  const from = containerOfFrameId(source);
  const to = containerOfFrameId(target);
  const betweenSessions =
    sourceHandle === connectionPorts.source && targetHandle === connectionPorts.target;
  if (betweenSessions && from !== undefined && to !== undefined) {
    return { kind: "sessions", from, to };
  }
  return {
    kind: "wire",
    from: { node: from ?? source, port: sourceHandle },
    to: { node: to ?? target, port: targetHandle },
  };
};

const toFlowContainerFrameViewNodes = (
  flow: Flow,
  selection: readonly string[],
  isIgnored: IsIgnored,
): ViewNode[] =>
  flow.containers.filter(hasFrame).map((container) => ({
    ...frameView(
      containerFrameId(container.id),
      "container-frame",
      flowContainerBounds(flow, container.id),
      {
        containerId: container.id,
        label: container.kind === "workspace" ? "Workspace" : container.name,
        ...(container.kind === "session" && { session: true }),
        ignored: isIgnored(container.id),
      },
    ),
    selected: selection.includes(container.id),
    zIndex: behindSelectedNodes,
  }));

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
  libraries?: LibraryLookup,
): ViewNode[] => {
  const carried = frameDragMoves(flow, dragPositions);
  const positions = { ...carried, ...dragPositions };
  const live = withPositions(flow, followed(flow, positions));
  const framing = withPositions(flow, { ...carried, ...containerMoves(flow, positions) });
  const ignoring = ignoredIn(flow, libraries);
  const isIgnored = ignoring.node;
  return [
    ...toFlowContainerFrameViewNodes(framing, selection, ignoring.container),
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

const connectionPrefix = "connection-";

export const connectionEdgeId = (id: string) => `${connectionPrefix}${id}`;

export const connectionOfEdge = (edgeId: string) => edgeId.slice(connectionPrefix.length);

const toConnectionEdges = (flow: Flow, selected: readonly string[]): ViewEdge[] => {
  const framed = new Set(flow.containers.filter(hasFrame).map(({ id }) => id));
  return (flow.connections ?? [])
    .filter(({ between }) => between.every((end) => framed.has(end)))
    .map(({ id, between: [from, to] }) => {
      const edge = connectionEdgeId(id);
      const isSelected = selected.includes(edge);
      const marker = {
        type: MarkerType.ArrowClosed,
        ...(isSelected && { color: "var(--select)" }),
      };
      return {
        id: edge,
        type: "connection" as const,
        source: containerFrameId(from),
        sourceHandle: connectionPorts.source,
        target: containerFrameId(to),
        targetHandle: connectionPorts.target,
        markerStart: marker,
        markerEnd: marker,
        style: { strokeDasharray: "6 4" },
        ...(isSelected && { selected: true }),
      };
    });
};

const drawnBounds = (flow: Flow, node: Node): Bounds =>
  (isBar(node) ? barBounds(flow, node) : null) ?? labelledBounds(node);

type WireGeometry = {
  boxes: ReadonlyMap<string, Bounds>;
  bodies: readonly { id: string; bounds: Bounds }[];
  frameOf: (containerId: string) => Bounds;
};

const wireGeometry = (flow: Flow): WireGeometry => {
  const frames = new Map<string, Bounds>();
  return {
    boxes: new Map(flow.nodes.map((node) => [node.id, drawnBounds(flow, node)])),
    bodies: flow.nodes
      .filter(isContainer)
      .map((scope) => ({ id: scope.id, bounds: bodyFrameBounds(flow, scope) })),
    frameOf: (containerId) => {
      const known = frames.get(containerId);
      if (known !== undefined) return known;
      const bounds = flowContainerBounds(flow, containerId);
      frames.set(containerId, bounds);
      return bounds;
    },
  };
};

const wireRouter = (flow: Flow, { boxes, bodies, frameOf }: WireGeometry) => {
  const nodes = new Map(flow.nodes.map((node) => [node.id, node]));
  const within = (id: string, scope: string): boolean => {
    const parent = nodes.get(id)?.parent;
    return id === scope || (parent !== undefined && within(parent, scope));
  };
  return (wire: Wire): Point[] | null => {
    const sender = nodes.get(wire.from.node);
    const from = boxes.get(wire.from.node);
    const to = boxes.get(wire.to.node);
    if (wire.kind !== "then" || sender === undefined || from === undefined || to === undefined)
      return null;
    const container = flowContainerOf(flow, wire.from.node);
    if (container === undefined || container.id !== flowContainerOf(flow, wire.to.node)?.id)
      return null;
    if (!leavesRow(from, to)) return null;
    const obstacles = [...boxes]
      .filter(([id]) => id !== wire.from.node && id !== wire.to.node)
      .map(([, bounds]) => bounds)
      .filter(clearOfEnds(from, to));
    const ends = wireEnds(sender, wire.from.port, from, to);
    if (!goesBack(from, to) && !bezierCrosses(ends.source, ends.side, ends.target, obstacles))
      return null;
    const foreignBodies = bodies
      .filter(({ id }) => !within(wire.from.node, id) && !within(wire.to.node, id))
      .map(({ bounds }) => bounds)
      .filter(clearOfEnds(from, to));
    return routeWire(
      {
        ...ends,
        ...(sender.type === "branch" && { stub: branchStub(wire.from.port, ends.side, textSpan) }),
      },
      [...obstacles, ...foreignBodies, from, to],
      frameOf(container.id),
    );
  };
};

const containerRouter = (flow: Flow, { boxes, bodies, frameOf }: WireGeometry) => {
  const framed = flow.containers.filter(hasFrame).map(({ id }) => id);
  const framedIds = new Set(framed);
  const bodyBounds = bodies.map(({ bounds }) => bounds);
  let drawing: { frames: Map<string, Bounds>; bounds: Bounds } | undefined;
  const drawn = () => {
    if (drawing !== undefined) return drawing;
    const frames = new Map(framed.map((id) => [id, frameOf(id)]));
    const all = [...boxes.values(), ...frames.values()];
    drawing = {
      frames,
      bounds: {
        left: Math.min(...all.map(({ left }) => left)) - ROUTE_MARGIN,
        top: Math.min(...all.map(({ top }) => top)) - ROUTE_MARGIN,
        right: Math.max(...all.map(({ right }) => right)) + ROUTE_MARGIN,
        bottom: Math.max(...all.map(({ bottom }) => bottom)) + ROUTE_MARGIN,
      },
    };
    return drawing;
  };
  return (wire: Wire): Point[] | null => {
    if (wire.kind !== "then") return null;
    if (!framedIds.has(wire.from.node) && !framedIds.has(wire.to.node)) return null;
    const { frames, bounds } = drawn();
    return routeAroundRows({
      from: wire.from.node,
      to: wire.to.node,
      boxes,
      bodies: bodyBounds,
      frames,
      bounds,
      crossesToday: (source, target, gate) => bezierCrosses(source, "right", target, gate),
    });
  };
};

const toWireEdges = (flow: Flow, selected: readonly string[]): ViewEdge[] => {
  const types = new Map(flow.nodes.map((node) => [node.id, node.type]));
  const containerIds = new Set(flow.containers.map(({ id }) => id));
  const viewId = (id: string) => (containerIds.has(id) ? containerFrameId(id) : id);
  const geometry = wireGeometry(flow);
  const route = wireRouter(flow, geometry);
  const routeAround = containerRouter(flow, geometry);
  return flow.wires.map((wire): ViewEdge => {
    const align = alignOf(types, wire);
    const id = edgeId(wire);
    const fromBranch = types.get(wire.from.node) === "branch";
    const isSelected = selected.includes(id);
    const today: ViewEdge = {
      id,
      source: viewId(wire.from.node),
      sourceHandle: wire.from.port,
      target: viewId(wire.to.node),
      targetHandle: wire.to.port,
      markerEnd: {
        type: MarkerType.ArrowClosed,
        ...(isSelected && { color: "var(--select)" }),
      },
      ...(align !== null && { type: "aligned" as const, data: { align } }),
      ...(fromBranch && { type: "branch" as const, data: { label: wire.from.port } }),
      ...(isSelected && { selected: true }),
    };
    const points = route(wire) ?? routeAround(wire);
    if (points === null) return today;
    return {
      ...today,
      type: "routed",
      data: { points, ...(fromBranch && { label: wire.from.port }) },
    };
  });
};

export const toViewEdges = (
  flow: Flow,
  selected: readonly string[] = [],
  dragPositions: Readonly<Record<string, Position>> = {},
): ViewEdge[] => {
  const positions = { ...frameDragMoves(flow, dragPositions), ...dragPositions };
  const live = withPositions(flow, followed(flow, positions));
  return [...toWireEdges(live, selected), ...toConnectionEdges(live, selected)];
};
