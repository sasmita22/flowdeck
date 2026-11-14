import type { CanvasNote, Flow, Node, NodeType } from "./schema.js";

type Bounds = { left: number; top: number; right: number; bottom: number };

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
};

const fixedWidth = new Set<NodeType>(["trigger", "output", "fork", "join"]);

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

const round = Math.round;

const rect = (box: Bounds, attributes: string): string =>
  `<rect x="${round(box.left)}" y="${round(box.top)}" width="${round(box.right - box.left)}" height="${round(box.bottom - box.top)}" ${attributes}/>`;

const textAt = (x: number, y: number, fill: string, text: string): string =>
  `<text x="${round(x)}" y="${round(y)}" fill="${fill}" font-family="sans-serif" font-size="12">${escape(text)}</text>`;

export function flowSvg(flow: Flow): string {
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

  const sessionNodes = (flow.session.frame?.nodes ?? []).flatMap((id) => {
    const node = byId.get(id);
    return node === undefined ? [] : [node];
  });
  const sessionBox =
    flow.session.frame === undefined || sessionNodes.length === 0
      ? undefined
      : padded(sessionNodes.map(boundsOf));

  const everything = [
    ...flow.nodes.map(boundsOf),
    ...notes.map(noteBounds),
    ...frames.map(({ box }) => box),
    ...(sessionBox === undefined ? [] : [sessionBox]),
  ];
  const view =
    everything.length === 0 ? { left: 0, top: 0, right: 0, bottom: 0 } : grown(everything, MARGIN);
  const width = round(view.right - view.left);
  const height = round(view.bottom - view.top);

  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${round(view.left)} ${round(view.top)} ${width} ${height}" width="${width}" height="${height}">`,
    rect(view, `data-kind="background" fill="${palette.background}"`),
  ];

  if (sessionBox !== undefined)
    parts.push(
      rect(
        sessionBox,
        `data-kind="session-frame" fill="none" stroke="${palette.session}" stroke-width="2" rx="10"`,
      ),
    );

  for (const { container, box } of frames)
    parts.push(
      rect(
        box,
        `data-kind="frame" data-id="${escape(container.id)}" fill="none" stroke="${palette.frame}" stroke-dasharray="6 4" rx="8"`,
      ),
    );

  for (const wire of flow.wires) {
    const from = byId.get(wire.from.node);
    const to = byId.get(wire.to.node);
    if (from === undefined || to === undefined) continue;
    const start = boundsOf(from);
    const end = boundsOf(to);
    const x1 = round(start.right);
    const y1 = round((start.top + start.bottom) / 2);
    const x2 = round(end.left);
    const y2 = round((end.top + end.bottom) / 2);
    const mid = round((x1 + x2) / 2);
    parts.push(
      `<path data-kind="wire" d="M${x1},${y1} H${mid} V${y2} H${x2}" fill="none" stroke="${palette.wire}" stroke-width="1.5"/>`,
    );
  }

  for (const node of flow.nodes) {
    const box = boundsOf(node);
    const { tag } = looks[node.type];
    const title = [tag, node.label].filter((part) => part !== "").join(" ");
    parts.push(
      `<g data-kind="node" data-id="${escape(node.id)}">`,
      rect(
        box,
        `fill="${isContainer(node) ? "none" : palette.node}" stroke="${palette.stroke}" rx="8"`,
      ),
      textAt(box.left + 10, (box.top + box.bottom) / 2 + 4, palette.text, title),
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
