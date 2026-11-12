import type { ELK, ElkExtendedEdge, ElkNode, LayoutOptions } from "elkjs/lib/elk-api.js";
import type { Flow, Node } from "../../../core/flow/schema.js";
import { parallelSections } from "../../../core/nodes/fork/execute.js";
import { nodeLook } from "../nodes/look.js";
import type { Move } from "./commands.js";
import { FRAME_PADDING, isContainer, widthOf } from "./frames.js";

type Position = { x: number; y: number };

type Size = { width: number; height: number };

type Laid = { width: number; boxes: Map<string, Position & Size> };

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

const rootOptions: LayoutOptions = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.edgeRouting": "ORTHOGONAL",
  "elk.hierarchyHandling": "INCLUDE_CHILDREN",
};

const chipGap = FRAME_PADDING;

const frameOptions = (container: Node): LayoutOptions => {
  const chipHeight = nodeLook(container.type).box.height;
  const top = FRAME_PADDING + chipHeight + chipGap;
  return {
    "elk.padding": `[top=${top},left=${FRAME_PADDING},bottom=${FRAME_PADDING},right=${FRAME_PADDING}]`,
    "elk.nodeSize.constraints": "MINIMUM_SIZE",
    "elk.nodeSize.minimum": `(${widthOf(container) + 2 * FRAME_PADDING}, ${top})`,
  };
};

const sectionOptions: LayoutOptions = { "elk.padding": "[top=0,left=0,bottom=0,right=0]" };

const graphOf = (flow: Flow, elkIds: Map<string, string>, options: LayoutOptions): ElkNode => {
  const childrenOf = new Map<string | undefined, Node[]>();
  for (const node of flow.nodes) {
    const parent = node.parent !== undefined && elkIds.has(node.parent) ? node.parent : undefined;
    childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), node]);
  }
  const elkNode = (node: Node): ElkNode => {
    const id = elkIds.get(node.id) ?? node.id;
    if (!isContainer(node))
      return { id, width: widthOf(node), height: nodeLook(node.type).box.height };
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
  const children: ElkNode[] = [];
  for (const node of childrenOf.get(undefined) ?? []) {
    const section = sectionOf.get(node.id);
    if (section === undefined) children.push(elkNode(node));
    else {
      if (section.children?.length === 0) children.push(section);
      section.children?.push(elkNode(node));
    }
  }
  const edges: ElkExtendedEdge[] = flow.wires.flatMap(({ kind, from, to }, index) => {
    const source = elkIds.get(from.node);
    const target = elkIds.get(to.node);
    if (kind !== "then" || source === undefined || target === undefined) return [];
    return [{ id: `e${index}`, sources: [source], targets: [target] }];
  });
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

const layOut = async (flow: Flow, options: LayoutOptions = {}): Promise<Laid> => {
  const elkIds = new Map(flow.nodes.map((node, index) => [node.id, `n${index}`]));
  const laid = await (await loadEngine()).layout(graphOf(flow, elkIds, options));
  const elkBoxes = new Map<string, Position & Size>();
  absoluteBoxes(laid.children ?? [], { x: 0, y: 0 }, elkBoxes);
  const boxes = new Map<string, Position & Size>();
  for (const [id, elkId] of elkIds) {
    const found = elkBoxes.get(elkId);
    if (found !== undefined) boxes.set(id, found);
  }
  return { width: laid.width ?? 0, boxes };
};

const wrapped = (flow: Flow, canvas: Size): Promise<Laid> =>
  layOut(flow, {
    "elk.layered.wrapping.strategy": "MULTI_EDGE",
    "elk.aspectRatio": String(canvas.width / canvas.height),
  });

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
  const unwrapped = await layOut(flow);
  const laid = unwrapped.width <= canvasSize.width ? unwrapped : await wrapped(flow, canvasSize);
  return flow.nodes.flatMap((node) => {
    const to = placeOf(flow, node, laid);
    if (to === undefined || (to.x === node.position.x && to.y === node.position.y)) return [];
    return [{ id: node.id, from: { ...node.position }, to }];
  });
}
