import type { CanvasNote, Flow, FlowContainer, Node, NodeType, Wire } from "./schema.js";
import { flowContainerMembers, flowContainerOf } from "./structure.js";
import {
  branchStub,
  clearOfEnds,
  goesBack,
  isClear,
  routePath,
  routeWire,
  wireEnds,
  type Bounds,
  type Point,
} from "./wire-router.js";

const FRAME_PADDING = 24;
const MARGIN = 32;
const CHAR_WIDTH = 7;
const TEXT_PADDING = 26;

const palette = {
  background: "#f7f7f5",
  node: "#ffffff",
  stroke: "#5b6470",
  frame: "#8a7fd0",
  session: "#3f8f6b",
  wire: "#7a828c",
  note: "#fff4c2",
  text: "#1f2328",
  tag: "#5b6470",
} as const;

const looks: Record<NodeType, { tag: string; width: number; height: number }> = {
  trigger: { tag: "", width: 48, height: 48 },
  output: { tag: "", width: 48, height: 48 },
  agent: { tag: "AGT", width: 170, height: 48 },
  gate: { tag: "GATE", width: 170, height: 48 },
  hardstop: { tag: "STOP", width: 170, height: 48 },
  ask: { tag: "ASK", width: 170, height: 57 },
  loop: { tag: "LOOP", width: 170, height: 48 },
  fork: { tag: "PARALLEL START", width: 28, height: 112 },
  join: { tag: "PARALLEL END", width: 28, height: 112 },
  foreach: { tag: "EACH", width: 170, height: 48 },
  branch: { tag: "IF", width: 116, height: 48 },
  library: { tag: "LIB", width: 170, height: 48 },
};

const fixedWidth = new Set<NodeType>(["trigger", "output", "fork", "join"]);

const isBar = (node: Node): boolean => node.type === "fork" || node.type === "join";

const LABEL_GAP = 6;

const tagWidth = (tag: string): number => tag.length * CHAR_WIDTH + 10;

const escape = (text: string): string =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

const isContainer = (node: Node): boolean => node.type === "loop" || node.type === "foreach";

const widthOf = (node: Node): number => {
  const { tag, width } = looks[node.type];
  if (fixedWidth.has(node.type)) return width;
  return Math.max(width, tagWidth(tag) + node.label.length * CHAR_WIDTH + TEXT_PADDING);
};

const boundsOf = (node: Node): Bounds => {
  const { x, y } = node.position;
  return { left: x, top: y, right: x + widthOf(node), bottom: y + looks[node.type].height };
};

const noteBounds = (note: CanvasNote): Bounds => ({
  left: note.position.x,
  top: note.position.y,
  right: note.position.x + note.size.width,
  bottom: note.position.y + note.size.height,
});

const grown = (all: readonly Bounds[], by: number): Bounds => ({
  left: Math.min(...all.map(({ left }) => left)) - by,
  top: Math.min(...all.map(({ top }) => top)) - by,
  right: Math.max(...all.map(({ right }) => right)) + by,
  bottom: Math.max(...all.map(({ bottom }) => bottom)) + by,
});

const padded = (all: readonly Bounds[]): Bounds => grown(all, FRAME_PADDING);

const depthOf = (flow: Flow, node: Node): number => {
  let depth = 0;
  let parent = node.parent;
  while (parent !== undefined && depth < flow.nodes.length) {
    depth += 1;
    parent = flow.nodes.find((candidate) => candidate.id === parent)?.parent;
  }
  return depth;
};

const containerLabel = (container: FlowContainer): string =>
  container.kind === "workspace" ? "Workspace" : container.name;

const round = Math.round;

const rect = (box: Bounds, attributes: string): string =>
  `<rect x="${round(box.left)}" y="${round(box.top)}" width="${round(box.right - box.left)}" height="${round(box.bottom - box.top)}" ${attributes}/>`;

const textAt = (x: number, y: number, fill: string, text: string): string =>
  `<text x="${round(x)}" y="${round(y)}" fill="${fill}" font-family="sans-serif" font-size="12">${escape(text)}</text>`;

const barTexts = (box: Bounds, tag: string, label: string): string[] => {
  const cx = round((box.left + box.right) / 2);
  const cy = round((box.top + box.bottom) / 2);
  return [
    `<text x="${cx}" y="${cy}" fill="${palette.tag}" font-family="sans-serif" font-size="12" text-anchor="middle" dominant-baseline="central" transform="rotate(-90 ${cx} ${cy})">${escape(tag)}</text>`,
    ...(label === ""
      ? []
      : [
          `<text x="${cx}" y="${round(box.top - LABEL_GAP)}" fill="${palette.text}" font-family="sans-serif" font-size="12" text-anchor="middle">${escape(label)}</text>`,
        ]),
  ];
};

const nodeTexts = (node: Node, box: Bounds): string[] => {
  const { tag } = looks[node.type];
  if (isBar(node)) return barTexts(box, tag, node.label);
  const title = [tag, node.label].filter((part) => part !== "").join(" ");
  return [textAt(box.left + 10, (box.top + box.bottom) / 2 + 4, palette.text, title)];
};

export type PictureWire = { from: string; to: string; points: Point[]; routed: boolean };

export type PictureLayout = {
  boxes: Map<string, Bounds>;
  bodies: Map<string, Bounds>;
  wires: PictureWire[];
};

const layoutOf = (flow: Flow) => {
  const notes = flow.notes ?? [];
  const byId = new Map(flow.nodes.map((node) => [node.id, node]));

  const frames = flow.nodes
    .filter(isContainer)
    .map((container) => ({
      container,
      depth: depthOf(flow, container),
      box: padded(
        [container, ...flow.nodes.filter((node) => node.parent === container.id)].map(boundsOf),
      ),
    }))
    .sort((a, b) => a.depth - b.depth);

  const containerFrames = flow.containers.flatMap((container) => {
    const members = new Set(flowContainerMembers(flow, container.id));
    const boxes = [
      ...flow.nodes.filter((node) => members.has(node.id)).map(boundsOf),
      ...frames.filter((frame) => members.has(frame.container.id)).map(({ box }) => box),
    ];
    return boxes.length === 0 ? [] : [{ container, box: padded(boxes) }];
  });

  const frameById = new Map(containerFrames.map(({ container, box }) => [container.id, box]));
  const endOf = (id: string): Bounds | undefined => {
    const node = byId.get(id);
    return node === undefined ? frameById.get(id) : boundsOf(node);
  };

  const boxes = new Map(flow.nodes.map((node) => [node.id, boundsOf(node)]));
  const within = (id: string, scope: string): boolean => {
    const parent = byId.get(id)?.parent;
    return id === scope || (parent !== undefined && within(parent, scope));
  };

  const routed = (wire: Wire, elbow: readonly Point[]): Point[] | null => {
    const sender = byId.get(wire.from.node);
    const from = boxes.get(wire.from.node);
    const to = boxes.get(wire.to.node);
    if (sender === undefined || from === undefined || to === undefined) return null;
    const obstacles = [...boxes]
      .filter(([id]) => id !== wire.from.node && id !== wire.to.node)
      .map(([, bounds]) => bounds);
    const foreignBodies = frames
      .filter(({ container }) => !within(wire.from.node, container.id))
      .filter(({ container }) => !within(wire.to.node, container.id))
      .map(({ box }) => box);
    if (!goesBack(from, to) && isClear(elbow, [...obstacles, ...foreignBodies])) return null;
    const container = flowContainerOf(flow, wire.from.node);
    if (container === undefined || container.id !== flowContainerOf(flow, wire.to.node)?.id)
      return null;
    const frame = frameById.get(container.id);
    if (frame === undefined) return null;
    const ends = wireEnds(sender, wire.from.port, from, to);
    const points = routeWire(
      {
        ...ends,
        ...(sender.type === "branch" && { stub: branchStub(wire.from.port, ends.side) }),
      },
      [
        ...obstacles.filter(clearOfEnds(from, to)),
        ...foreignBodies.filter(clearOfEnds(from, to)),
        from,
        to,
      ],
      frame,
    );
    return points?.map(({ x, y }) => ({ x: round(x), y: round(y) })) ?? null;
  };

  const wires = flow.wires.flatMap((wire): PictureWire[] => {
    const start = endOf(wire.from.node);
    const end = endOf(wire.to.node);
    if (start === undefined || end === undefined) return [];
    const x1 = round(start.right);
    const y1 = round((start.top + start.bottom) / 2);
    const x2 = round(end.left);
    const y2 = round((end.top + end.bottom) / 2);
    const mid = round((x1 + x2) / 2);
    const elbow = [
      { x: x1, y: y1 },
      { x: mid, y: y1 },
      { x: mid, y: y2 },
      { x: x2, y: y2 },
    ];
    const route = routed(wire, elbow);
    return [
      {
        from: wire.from.node,
        to: wire.to.node,
        points: route ?? elbow,
        routed: route !== null,
      },
    ];
  });

  return { notes, boxes, frames, containerFrames, wires };
};

export const pictureLayout = (flow: Flow): PictureLayout => {
  const { boxes, frames, wires } = layoutOf(flow);
  return {
    boxes,
    bodies: new Map(frames.map(({ container, box }) => [container.id, box])),
    wires,
  };
};

const elbowPath = (points: readonly Point[]): string => {
  const [start, bend, , end] = points as [Point, Point, Point, Point];
  return `M${start.x},${start.y} H${bend.x} V${end.y} H${end.x}`;
};

export function flowSvg(flow: Flow): string {
  const { notes, frames, containerFrames, wires } = layoutOf(flow);

  const everything = [
    ...flow.nodes.map(boundsOf),
    ...notes.map(noteBounds),
    ...frames.map(({ box }) => box),
    ...containerFrames.map(({ box }) => box),
  ];
  const view =
    everything.length === 0 ? { left: 0, top: 0, right: 0, bottom: 0 } : grown(everything, MARGIN);
  const width = round(view.right - view.left);
  const height = round(view.bottom - view.top);

  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${round(view.left)} ${round(view.top)} ${width} ${height}" width="${width}" height="${height}">`,
    rect(view, `data-kind="background" fill="${palette.background}"`),
  ];

  for (const { container, box } of containerFrames)
    parts.push(
      `<g data-kind="container-frame" data-id="${escape(container.id)}">`,
      rect(box, `fill="none" stroke="${palette.session}" stroke-width="2" rx="10"`),
      textAt(box.left + 10, box.top + 16, palette.session, containerLabel(container)),
      "</g>",
    );

  for (const { container, box } of frames)
    parts.push(
      rect(
        box,
        `data-kind="frame" data-id="${escape(container.id)}" fill="none" stroke="${palette.frame}" stroke-dasharray="6 4" rx="8"`,
      ),
    );

  for (const { points, routed } of wires)
    parts.push(
      `<path data-kind="wire" d="${routed ? routePath(points) : elbowPath(points)}" fill="none" stroke="${palette.wire}" stroke-width="1.5"/>`,
    );

  for (const node of flow.nodes) {
    const box = boundsOf(node);
    parts.push(
      `<g data-kind="node" data-id="${escape(node.id)}">`,
      rect(
        box,
        `fill="${isContainer(node) ? "none" : palette.node}" stroke="${palette.stroke}" rx="8"`,
      ),
      ...nodeTexts(node, box),
      "</g>",
    );
  }

  for (const note of notes) {
    const box = noteBounds(note);
    parts.push(
      `<g data-kind="note" data-id="${escape(note.id)}">`,
      rect(box, `fill="${palette.note}" stroke="${palette.tag}"`),
      textAt(box.left + 8, box.top + 18, palette.text, note.text),
      "</g>",
    );
  }

  parts.push("</svg>");
  return parts.join("");
}
