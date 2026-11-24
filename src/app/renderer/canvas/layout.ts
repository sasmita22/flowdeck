import type { ELK, ElkExtendedEdge, ElkNode, LayoutOptions } from "elkjs/lib/elk-api.js";
import type { Flow, Node } from "../../../core/flow/schema.js";
import { parallelSections } from "../../../core/nodes/fork/execute.js";
import { nodeLook } from "../nodes/look.js";
import type { Move } from "./commands.js";
import { FRAME_PADDING, hasSideLabel, isContainer, sideLabelSpan, widthOf } from "./frames.js";

type Position = { x: number; y: number };

type Size = { width: number; height: number };

type Laid = { width: number; boxes: Map<string, Position & Size>; wide: Set<string> };

type Wraps = (elkId: string) => boolean;

type ElkClass = new () => ELK;

// elkjs is CommonJS: NodeNext types its default import as the module, Bundler as the class.
const elkClass = (loaded: ElkClass | { default: ElkClass }): ElkClass =>
  "default" in loaded ? loaded.default : loaded;

let engine: Promise<ELK> | undefined;

const loadEngine = (): Promise<ELK> => {
  engine ??= import("elkjs/lib/elk.bundled.js").then(({ default: loaded }) => {
    const Elk = elkClass(loaded);
    return new Elk();
  });
  return engine;
};

export const LAYER_GAP = 150;

const layerGap: LayoutOptions = {
  "elk.layered.spacing.nodeNodeBetweenLayers": String(LAYER_GAP),
};

const rootOptions: LayoutOptions = {
  ...layerGap,
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.edgeRouting": "ORTHOGONAL",
  "elk.hierarchyHandling": "INCLUDE_CHILDREN",
  "elk.padding": "[top=0,left=0,bottom=0,right=0]",
};

const chipGap = FRAME_PADDING;

const frameOptions = (container: Node): LayoutOptions => {
  const chipHeight = nodeLook(container.type).box.height;
  const top = FRAME_PADDING + chipHeight + chipGap;
  return {
    ...layerGap,
    "elk.padding": `[top=${top},left=${FRAME_PADDING},bottom=${FRAME_PADDING},right=${FRAME_PADDING}]`,
    "elk.nodeSize.constraints": "MINIMUM_SIZE",
    "elk.nodeSize.minimum": `(${widthOf(container) + 2 * FRAME_PADDING}, ${top})`,
  };
};

const sectionOptions: LayoutOptions = {
  ...layerGap,
  "elk.padding": "[top=0,left=0,bottom=0,right=0]",
};

const containerOptions: LayoutOptions = {
  ...layerGap,
  "elk.padding": `[top=${FRAME_PADDING},left=${FRAME_PADDING},bottom=${FRAME_PADDING},right=${FRAME_PADDING}]`,
};

const connectedGroups = (
  children: readonly ElkNode[],
  edges: readonly ElkExtendedEdge[],
): ElkNode[] => {
  const topOf = new Map<string, string>();
  const claim = (node: ElkNode, top: string) => {
    topOf.set(node.id, top);
    for (const child of node.children ?? []) claim(child, top);
  };
  for (const child of children) claim(child, child.id);
  const leader = new Map(children.map(({ id }) => [id, id]));
  const find = (id: string): string => {
    const up = leader.get(id) ?? id;
    return up === id ? id : find(up);
  };
  for (const { sources, targets } of edges) {
    const a = topOf.get(sources[0] ?? "");
    const b = topOf.get(targets[0] ?? "");
    if (a !== undefined && b !== undefined) leader.set(find(a), find(b));
  }
  const groups = new Map<string, ElkNode[]>();
  for (const child of children) {
    const key = find(child.id);
    groups.set(key, [...(groups.get(key) ?? []), child]);
  }
  if (groups.size < 2) return [...children];
  return [...groups.values()].map((members, index) => {
    const [only, ...rest] = members;
    if (only !== undefined && rest.length === 0) return only;
    return { id: `k${index}`, layoutOptions: sectionOptions, children: members };
  });
};

const layoutWidthOf = (node: Node): number =>
  hasSideLabel(node) ? widthOf(node) + sideLabelSpan(node.label) : widthOf(node);

const graphOf = (
  flow: Flow,
  elkIds: Map<string, string>,
  options: LayoutOptions,
  wraps: Wraps,
): ElkNode => {
  const childrenOf = new Map<string | undefined, Node[]>();
  for (const node of flow.nodes) {
    const parent = node.parent !== undefined && elkIds.has(node.parent) ? node.parent : undefined;
    childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), node]);
  }
  const elkNode = (node: Node): ElkNode => {
    const id = elkIds.get(node.id) ?? node.id;
    if (!isContainer(node))
      return { id, width: layoutWidthOf(node), height: nodeLook(node.type).box.height };
    return {
      id,
      layoutOptions: frameOptions(node),
      children: (childrenOf.get(node.id) ?? []).map(elkNode),
    };
  };
  const sectionOf = new Map<string, ElkNode>();
  for (const [index, { fork, branches, join }] of parallelSections(
    flow.nodes,
    flow.wires,
  ).sections.entries()) {
    const section: ElkNode = { id: `g${index}`, layoutOptions: sectionOptions, children: [] };
    for (const member of [fork, ...branches, join]) sectionOf.set(member, section);
  }
  const frames: ElkNode[] = flow.containers.map((_, index) => ({
    id: `c${index}`,
    layoutOptions: { ...containerOptions, ...(wraps(`c${index}`) ? options : {}) },
    children: [],
  }));
  const frameOf = new Map(
    flow.containers.flatMap(({ nodes }, index) => nodes.map((id) => [id, frames[index]] as const)),
  );
  const parentOf = new Map(flow.nodes.map((node) => [node.id, node.parent]));
  const topOf = (id: string): string => {
    const parent = parentOf.get(id);
    return parent === undefined ? id : topOf(parent);
  };
  const links = flow.wires
    .filter(({ kind }) => kind === "then")
    .map(({ from, to }) => [topOf(from.node), topOf(to.node)] as const);
  for (let joined = true; joined;) {
    joined = false;
    for (const [a, b] of links) {
      const [held, loose] = frameOf.has(a) ? [a, b] : [b, a];
      const frame = frameOf.get(held);
      if (frame === undefined || frameOf.has(loose)) continue;
      frameOf.set(loose, frame);
      joined = true;
    }
  }
  const root: ElkNode[] = [];
  const holderOf = (id: string): ElkNode[] => frameOf.get(id)?.children ?? root;
  for (const node of childrenOf.get(undefined) ?? []) {
    const section = sectionOf.get(node.id);
    if (section === undefined) holderOf(node.id).push(elkNode(node));
    else {
      if (section.children?.length === 0) holderOf(node.id).push(section);
      section.children?.push(elkNode(node));
    }
  }
  const drawn = frames.filter((frame) => frame.children?.length !== 0);
  const frameIds = new Map(
    flow.containers.flatMap(({ id }, index) => {
      const frame = frames[index];
      return frame !== undefined && drawn.includes(frame) ? [[id, frame.id] as const] : [];
    }),
  );
  const elkIdOf = (id: string) => elkIds.get(id) ?? frameIds.get(id);
  const edges: ElkExtendedEdge[] = flow.wires.flatMap(({ kind, from, to }, index) => {
    const source = elkIdOf(from.node);
    const target = elkIdOf(to.node);
    if (kind !== "then" || source === undefined || target === undefined) return [];
    return [{ id: `e${index}`, sources: [source], targets: [target] }];
  });
  const children = connectedGroups([...drawn, ...root], edges);
  return { id: "root", layoutOptions: { ...rootOptions, ...options }, children, edges };
};

const absoluteBoxes = (
  nodes: readonly ElkNode[],
  origin: Position,
  boxes: Map<string, Position & Size>,
): void => {
  for (const node of nodes) {
    const x = origin.x + (node.x ?? 0);
    const y = origin.y + (node.y ?? 0);
    boxes.set(node.id, { x, y, width: node.width ?? 0, height: node.height ?? 0 });
    absoluteBoxes(node.children ?? [], { x, y }, boxes);
  }
};

const layOut = async (
  flow: Flow,
  canvas: Size,
  options: LayoutOptions = {},
  wraps: Wraps = () => true,
): Promise<Laid> => {
  const elkIds = new Map(flow.nodes.map((node, index) => [node.id, `n${index}`]));
  const laid = await (await loadEngine()).layout(graphOf(flow, elkIds, options, wraps));
  const elkBoxes = new Map<string, Position & Size>();
  absoluteBoxes(laid.children ?? [], { x: 0, y: 0 }, elkBoxes);
  const boxes = new Map<string, Position & Size>();
  for (const [id, elkId] of elkIds) {
    const found = elkBoxes.get(elkId);
    if (found !== undefined) boxes.set(id, found);
  }
  const wide = new Set(
    [...elkBoxes].flatMap(([id, { width }]) => (width > canvas.width ? [id] : [])),
  );
  return { width: laid.width ?? 0, boxes, wide };
};

const ELK_DEFAULT_LAYER_GAP = 20;

const meanWidth = (flow: Flow): number => {
  const widths = flow.nodes.filter((node) => !isContainer(node)).map(layoutWidthOf);
  return widths.reduce((sum, width) => sum + width, 0) / Math.max(widths.length, 1);
};

const wrapRatio = (flow: Flow, canvas: Size): number => {
  const width = meanWidth(flow);
  return ((canvas.width / canvas.height) * (width + ELK_DEFAULT_LAYER_GAP)) / (width + LAYER_GAP);
};

const wrapped = (flow: Flow, canvas: Size, wide: ReadonlySet<string>): Promise<Laid> =>
  layOut(
    flow,
    canvas,
    {
      "elk.layered.wrapping.strategy": "MULTI_EDGE",
      "elk.aspectRatio": String(wrapRatio(flow, canvas)),
    },
    (id) => wide.has(id),
  );

const isBar = (node: Node): boolean => node.type === "fork" || node.type === "join";

const barTop = (flow: Flow, bar: Node, laid: Laid): number | undefined => {
  const branches = flow.wires.flatMap(({ kind, from, to }) => {
    if (kind !== "then") return [];
    if (bar.type === "fork" && from.node === bar.id) return [to.node];
    if (bar.type === "join" && to.node === bar.id) return [from.node];
    return [];
  });
  const tops = flow.nodes
    .filter((node) => branches.includes(node.id) && !isBar(node))
    .flatMap((node) => {
      const found = laid.boxes.get(node.id);
      return found === undefined ? [] : [found.y];
    });
  return tops.length === 0 ? undefined : Math.min(...tops);
};

const placeOf = (flow: Flow, node: Node, laid: Laid): Position | undefined => {
  const found = laid.boxes.get(node.id);
  if (found === undefined) return undefined;
  const offset = isContainer(node) ? FRAME_PADDING : 0;
  const y = (isBar(node) ? barTop(flow, node, laid) : undefined) ?? found.y + offset;
  return { x: Math.round(found.x + offset), y: Math.round(y) };
};

export async function tidyMoves(flow: Flow, canvasSize: Size): Promise<Move[]> {
  if (flow.nodes.length === 0) return [];
  const unwrapped = await layOut(flow, canvasSize);
  const laid =
    unwrapped.width <= canvasSize.width
      ? unwrapped
      : await wrapped(flow, canvasSize, unwrapped.wide);
  return flow.nodes.flatMap((node) => {
    const to = placeOf(flow, node, laid);
    if (to === undefined || (to.x === node.position.x && to.y === node.position.y)) return [];
    return [{ id: node.id, from: { ...node.position }, to }];
  });
}
