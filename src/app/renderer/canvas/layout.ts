import type { ELK, ElkExtendedEdge, ElkNode, LayoutOptions } from "elkjs/lib/elk-api.js";
import { canvasStart } from "../../../core/flow/main-flow.js";
import type { Flow, Node } from "../../../core/flow/schema.js";
import { flowContainerOf } from "../../../core/flow/structure.js";
import { parallelSections } from "../../../core/nodes/fork/execute.js";
import { nodeLook } from "../nodes/look.js";
import type { Move } from "./commands.js";
import { FRAME_PADDING, hasSideLabel, isContainer, sideLabelSpan, widthOf } from "./frames.js";

type Position = { x: number; y: number };

type Size = { width: number; height: number };

type Box = Position & Size;

type Laid = { width: number; boxes: Map<string, Box>; wide: Set<string>; elk: ElkNode };

type Packed = Size & { boxes: Map<string, Box> };

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

const isBar = (node: Node): boolean => node.type === "fork" || node.type === "join";

const branchesOf = (flow: Flow, bar: Node): Node[] => {
  const branches = new Set(
    flow.wires.flatMap(({ kind, from, to }) => {
      if (kind !== "then") return [];
      if (bar.type === "fork" && from.node === bar.id) return [to.node];
      if (bar.type === "join" && to.node === bar.id) return [from.node];
      return [];
    }),
  );
  return flow.nodes.filter((node) => branches.has(node.id) && !isBar(node));
};

type BarGroup = { bar: Node; branches: Node[] };

const unfinishedBarsOf = (flow: Flow, grouped: ReadonlySet<string>): BarGroup[] => {
  const taken = new Set(grouped);
  return flow.nodes.flatMap((bar) => {
    if (!isBar(bar) || taken.has(bar.id)) return [];
    const branches = branchesOf(flow, bar);
    const members = [bar, ...branches].map(({ id }) => id);
    if (members.some((id) => taken.has(id))) return [];
    for (const id of members) taken.add(id);
    return [{ bar, branches }];
  });
};

const sectionMembersOf = (flow: Flow): Set<string> =>
  new Set(
    parallelSections(flow.nodes, flow.wires).sections.flatMap(({ fork, branches, join }) => [
      fork,
      ...branches,
      join,
    ]),
  );

const layoutWidthOf = (node: Node): number =>
  hasSideLabel(node) ? widthOf(node) + sideLabelSpan(node.label) : widthOf(node);

const graphOf = (
  flow: Flow,
  elkIds: Map<string, string>,
  options: LayoutOptions,
  packed: ReadonlyMap<string, Packed>,
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
  const { sections } = parallelSections(flow.nodes, flow.wires);
  const groupOf = (index: number): ElkNode => ({
    id: `g${index}`,
    layoutOptions: sectionOptions,
    children: [],
  });
  for (const [index, { fork, branches, join }] of sections.entries()) {
    const section = groupOf(index);
    for (const member of [fork, ...branches, join]) sectionOf.set(member, section);
  }
  const unfinished = unfinishedBarsOf(flow, new Set(sectionOf.keys()));
  for (const [index, { bar, branches }] of unfinished.entries()) {
    const group = groupOf(sections.length + index);
    for (const { id } of [bar, ...branches]) sectionOf.set(id, group);
  }
  const frames: ElkNode[] = flow.containers.map((_, index) => ({
    id: `c${index}`,
    layoutOptions: containerOptions,
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
  const packedFrameOf = (id: string): string | undefined => {
    const frame = frameOf.get(topOf(id));
    return frame !== undefined && packed.has(frame.id) ? frame.id : undefined;
  };
  const elkIdOf = (id: string) => packedFrameOf(id) ?? elkIds.get(id) ?? frameIds.get(id);
  const edges: ElkExtendedEdge[] = flow.wires.flatMap(({ kind, from, to }, index) => {
    const source = elkIdOf(from.node);
    const target = elkIdOf(to.node);
    if (kind !== "then" || source === undefined || target === undefined || source === target)
      return [];
    return [{ id: `e${index}`, sources: [source], targets: [target] }];
  });
  const placed = drawn.map((frame): ElkNode => {
    const size = packed.get(frame.id);
    return size === undefined ? frame : { id: frame.id, width: size.width, height: size.height };
  });
  const children = connectedGroups([...placed, ...root], edges);
  return { id: "root", layoutOptions: { ...rootOptions, ...options }, children, edges };
};

const absoluteBoxes = (
  nodes: readonly ElkNode[],
  origin: Position,
  boxes: Map<string, Box>,
): void => {
  for (const node of nodes) {
    const x = origin.x + (node.x ?? 0);
    const y = origin.y + (node.y ?? 0);
    boxes.set(node.id, { x, y, width: node.width ?? 0, height: node.height ?? 0 });
    absoluteBoxes(node.children ?? [], { x, y }, boxes);
  }
};

const elkIdsOf = (flow: Flow): Map<string, string> =>
  new Map(flow.nodes.map((node, index) => [node.id, `n${index}`]));

const layOut = async (
  flow: Flow,
  canvas: Size,
  options: LayoutOptions = {},
  packed: ReadonlyMap<string, Packed> = new Map(),
  packsRoot = false,
): Promise<Laid> => {
  const elkIds = elkIdsOf(flow);
  const laid = await (await loadEngine()).layout(graphOf(flow, elkIds, options, packed));
  const rootPack =
    packsRoot && (laid.width ?? 0) > canvas.width
      ? pack(laid, canvas.width, linksOf(laid), 0)
      : undefined;
  const elkBoxes = rootPack?.boxes ?? new Map<string, Box>();
  if (rootPack === undefined) absoluteBoxes(laid.children ?? [], { x: 0, y: 0 }, elkBoxes);
  for (const [frameId, { boxes: inner }] of packed) {
    const origin = elkBoxes.get(frameId);
    if (origin === undefined) continue;
    for (const [id, found] of inner)
      elkBoxes.set(id, { ...found, x: origin.x + found.x, y: origin.y + found.y });
  }
  const boxes = new Map<string, Box>();
  for (const [id, elkId] of elkIds) {
    const found = elkBoxes.get(elkId);
    if (found !== undefined) boxes.set(id, found);
  }
  const wide = new Set(
    [...elkBoxes].flatMap(([id, { width }]) => (width > canvas.width ? [id] : [])),
  );
  return { width: rootPack?.width ?? laid.width ?? 0, boxes, wide, elk: laid };
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

type Span = { left: number; right: number; top: number; bottom: number };

type Item = Span & { boxes: Map<string, Box> };

type Row = { left: number; right: number; blocks: Item[][] };

const spanOf = (items: readonly Item[]): Span => ({
  left: Math.min(...items.map(({ left }) => left)),
  right: Math.max(...items.map(({ right }) => right)),
  top: Math.min(...items.map(({ top }) => top)),
  bottom: Math.max(...items.map(({ bottom }) => bottom)),
});

const itemOf = (child: ElkNode): Item => {
  const boxes = new Map<string, Box>();
  absoluteBoxes([child], { x: 0, y: 0 }, boxes);
  const { x, y, width, height } = boxes.get(child.id) ?? { x: 0, y: 0, width: 0, height: 0 };
  return { left: x, right: x + width, top: y, bottom: y + height, boxes };
};

const blocksOf = (items: readonly Item[]): Item[][] => {
  const blocks: Item[][] = [];
  let right = -Infinity;
  for (const item of items) {
    const last = blocks.at(-1);
    if (last !== undefined && item.left < right) last.push(item);
    else blocks.push([item]);
    right = Math.max(right, item.right);
  }
  return blocks;
};

const rowsOf = (blocks: readonly Item[][], rowWidth: number): Row[] => {
  const rows: Row[] = [];
  for (const block of blocks) {
    const last = rows.at(-1);
    const { left, right } = spanOf(block);
    if (last !== undefined && right - last.left <= rowWidth) {
      last.blocks.push(block);
      last.right = Math.max(last.right, right);
    } else rows.push({ left, right, blocks: [block] });
  }
  return rows;
};

type Link = { from: string; to: string };

type Placed = { box: Box; block: number };

const linksOf = (graph: ElkNode): Link[] =>
  (graph.edges ?? []).flatMap(({ sources, targets }) => {
    const [from] = sources;
    const [to] = targets;
    return from === undefined || to === undefined ? [] : [{ from, to }];
  });

const middleOf = ({ y, height }: Box): number => y + height / 2;

const shiftOf = (
  block: readonly Item[],
  placed: ReadonlyMap<string, Placed>,
  links: readonly Link[],
): number => {
  const own = new Map(block.flatMap((item) => [...item.boxes]));
  const [chosen] = links
    .flatMap(({ from, to }) => {
      const sender = placed.get(from);
      const receiver = own.get(to);
      return sender === undefined || receiver === undefined ? [] : [{ sender, receiver }];
    })
    .sort(
      (a, b) =>
        b.sender.block - a.sender.block ||
        a.sender.box.y - b.sender.box.y ||
        a.receiver.y - b.receiver.y,
    );
  return chosen === undefined
    ? -spanOf(block).top
    : middleOf(chosen.sender.box) - middleOf(chosen.receiver);
};

const pack = (
  frame: ElkNode,
  rowWidth: number,
  links: readonly Link[],
  margin = FRAME_PADDING,
): Packed => {
  const items = (frame.children ?? []).map(itemOf).sort((a, b) => a.left - b.left);
  const boxes = new Map<string, Box>();
  let top = margin;
  let width = 0;
  for (const row of rowsOf(blocksOf(items), rowWidth)) {
    const dx = margin - row.left;
    const placed = new Map<string, Placed>();
    for (const [index, block] of row.blocks.entries()) {
      const dy = shiftOf(block, placed, links);
      for (const item of block)
        for (const [id, found] of item.boxes)
          placed.set(id, { box: { ...found, x: found.x + dx, y: found.y + dy }, block: index });
    }
    const all = [...placed.values()].map(({ box }) => box);
    const highest = Math.min(...all.map(({ y }) => y));
    const lowest = Math.max(...all.map(({ y, height }) => y + height));
    for (const [id, { box }] of placed) boxes.set(id, { ...box, y: box.y - highest + top });
    top += lowest - highest + LAYER_GAP;
    width = Math.max(width, row.right - row.left);
  }
  return {
    width: width + 2 * margin,
    height: top - LAYER_GAP + margin,
    boxes,
  };
};

const framesOf = (nodes: readonly ElkNode[]): ElkNode[] =>
  nodes.flatMap((node) => (node.id.startsWith("c") ? [node] : framesOf(node.children ?? [])));

const rootLeavesOf = (nodes: readonly ElkNode[]): string[] =>
  nodes.flatMap((node) => {
    if (node.id.startsWith("c")) return [];
    if (node.id.startsWith("n")) return [node.id];
    return rootLeavesOf(node.children ?? []);
  });

const canvasEnds = (flow: Flow): Set<string> => {
  const start = canvasStart(flow);
  const elkIds = elkIdsOf(flow);
  return new Set(
    flow.nodes
      .filter(
        (node) =>
          node.parent === undefined &&
          flowContainerOf(flow, node.id) === undefined &&
          (node.id === start || node.type === "output"),
      )
      .flatMap((node) => elkIds.get(node.id) ?? []),
  );
};

const holdsOnlyCanvasEnds = (flow: Flow, root: readonly ElkNode[]): boolean => {
  const ends = canvasEnds(flow);
  return rootLeavesOf(root).every((id) => ends.has(id));
};

const wrapped = (flow: Flow, canvas: Size, unwrapped: Laid): Promise<Laid> => {
  const rowWidth = canvas.width - 2 * FRAME_PADDING;
  const links = linksOf(unwrapped.elk);
  const root = unwrapped.elk.children ?? [];
  const drawn = framesOf(root);
  const packed = new Map(
    drawn
      .filter(({ id }) => unwrapped.wide.has(id))
      .map((frame) => [frame.id, pack(frame, rowWidth, links)] as const),
  );
  if (drawn.length > 0)
    return layOut(flow, canvas, {}, packed, drawn.length > 1 || !holdsOnlyCanvasEnds(flow, root));
  return layOut(flow, canvas, {
    "elk.layered.wrapping.strategy": "MULTI_EDGE",
    "elk.aspectRatio": String(wrapRatio(flow, canvas)),
  });
};

const alignedBranches = (flow: Flow, laid: Laid): Laid => {
  const boxes = new Map(laid.boxes);
  for (const { bar, branches } of unfinishedBarsOf(flow, sectionMembersOf(flow))) {
    if ([bar, ...branches].some(({ parent }) => parent !== undefined)) continue;
    const barBox = boxes.get(bar.id);
    const tops = branches.flatMap(({ id }) => boxes.get(id)?.y ?? []);
    if (barBox === undefined || tops.length === 0) continue;
    const rise = Math.min(...tops) - barBox.y;
    if (rise <= 0) continue;
    for (const { id } of branches) {
      const found = boxes.get(id);
      if (found !== undefined) boxes.set(id, { ...found, y: found.y - rise });
    }
  }
  return { ...laid, boxes };
};

const barTop = (flow: Flow, bar: Node, laid: Laid): number | undefined => {
  const tops = branchesOf(flow, bar).flatMap((node) => {
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
  const laid = alignedBranches(
    flow,
    unwrapped.width <= canvasSize.width ? unwrapped : await wrapped(flow, canvasSize, unwrapped),
  );
  return flow.nodes.flatMap((node) => {
    const to = placeOf(flow, node, laid);
    if (to === undefined || (to.x === node.position.x && to.y === node.position.y)) return [];
    return [{ id: node.id, from: { ...node.position }, to }];
  });
}
