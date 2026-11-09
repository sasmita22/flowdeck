import type { NodeType } from "../../../core/flow/schema.js";
import { nodeLook } from "./look.js";
import { noteLook } from "./note-look.js";

export const roundedRect = (width: number, height: number, r: number, inset = 0): string => {
  const [x, y, w, h] = [inset, inset, width - 2 * inset, height - 2 * inset];
  return `M${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h - r} Q${x + w},${y + h} ${x + w - r},${y + h} H${x + r} Q${x},${y + h} ${x},${y + h - r} V${y + r} Q${x},${y} ${x + r},${y} Z`;
};

export const octagon = (w: number, h: number, c: number): string =>
  `M${c},0 H${w - c} L${w},${c} V${h - c} L${w - c},${h} H${c} L0,${h - c} V${c} Z`;

export interface ShapeExtra {
  element: "path" | "rect" | "polygon";
  attributes: Readonly<Record<string, string | number>>;
}

export interface NodeOutline {
  path: string;
  padL: number;
  fill: string;
  strokeWidth: number;
  ink?: string;
  extras: readonly ShapeExtra[];
}

export type OutlinedType = Exclude<NodeType, "fork" | "join">;

const w = 170;
const h = 48;
const r = h / 2;

const outline = (path: string, padL: number, more: Partial<NodeOutline> = {}): NodeOutline => ({
  path,
  padL,
  fill: "var(--panel)",
  strokeWidth: 1.4,
  extras: [],
  ...more,
});

const container = (width: number) => outline(roundedRect(width, h, 4), 8, { fill: "none" });

const human = nodeLook("hardstop").group;
const work = nodeLook("agent").group;
const ctrl = nodeLook("branch").group;

const branch = nodeLook("branch").box;
const hexagon = (width: number) =>
  `12,0 ${width - 12},0 ${width},${branch.height / 2} ${width - 12},${branch.height} 12,${branch.height} 0,${branch.height / 2}`;

const circle = (inset = 0): string => {
  const radius = r - inset;
  return `M${inset},${r} A${radius},${radius} 0 1 1 ${h - inset},${r} A${radius},${radius} 0 1 1 ${inset},${r} Z`;
};

const io = nodeLook("trigger").group;

const outlines: Record<OutlinedType, (w: number) => NodeOutline> = {
  trigger: () => outline(circle(), 8),
  output: () =>
    outline(circle(), 8, {
      strokeWidth: 3,
      extras: [
        {
          element: "path",
          attributes: { d: circle(5), fill: "none", stroke: io, strokeWidth: 1.4 },
        },
      ],
    }),
  prompt: (w) => outline(roundedRect(w, h, 4), 8),
  agent: (w) =>
    outline(roundedRect(w, h, 12), 10, {
      strokeWidth: 1.6,
      extras: [
        {
          element: "path",
          attributes: {
            d: roundedRect(w, h, 9, 3.5),
            fill: "none",
            stroke: work,
            strokeOpacity: 0.4,
          },
        },
      ],
    }),
  script: (w) =>
    outline(roundedRect(w, h, 6), 8, {
      fill: "var(--term-bg)",
      strokeWidth: 1,
      ink: "var(--term-fg)",
    }),
  gate: (w) =>
    outline(roundedRect(w, h, 3), 12, {
      strokeWidth: 1,
      extras: [
        { element: "rect", attributes: { x: 0, y: 0, width: 5, height: h, rx: 2, fill: human } },
        {
          element: "rect",
          attributes: { x: w - 5, y: 0, width: 5, height: h, rx: 2, fill: human },
        },
      ],
    }),
  hardstop: (w) => {
    const stop = octagon(w, h, 13);
    return outline(stop, 12, {
      strokeWidth: 2,
      extras: [{ element: "path", attributes: { d: stop, fill: human, fillOpacity: 0.14 } }],
    });
  },
  ask: (w) =>
    outline(
      `M8,0 H${w - 8} Q${w},0 ${w},8 V${h - 8} Q${w},${h} ${w - 8},${h} H28 L16,${h + 9} L18,${h} H8 Q0,${h} 0,${h - 8} V8 Q0,0 8,0 Z`,
      8,
    ),
  loop: container,
  foreach: container,
  branch: (w) =>
    outline(`M${hexagon(w).replaceAll(" ", " L")} Z`, 14, {
      extras: [
        { element: "polygon", attributes: { points: hexagon(w), fill: ctrl, fillOpacity: 0.08 } },
      ],
    }),
};

export const nodeOutline = (type: OutlinedType, width = nodeLook(type).box.width): NodeOutline =>
  outlines[type](width);

export const barLook = { rx: 8, fillOpacity: 0.16, strokeWidth: 1.4 } as const;

export const frameLook = {
  rx: 10,
  fillOpacity: 0.05,
  strokeOpacity: 0.6,
  strokeWidth: 1.4,
  dash: "6 4",
} as const;

export type Preview =
  | { kind: "node"; type: OutlinedType; outline: NodeOutline }
  | { kind: "bar"; type: "fork" | "join"; bar: typeof barLook }
  | { kind: "frame"; type: "loop" | "foreach"; frame: typeof frameLook }
  | { kind: "note"; type: "note"; note: typeof noteLook };

export const previewOf = (type: NodeType | "note"): Preview => {
  if (type === "note") return { kind: "note", type, note: noteLook };
  if (type === "fork" || type === "join") return { kind: "bar", type, bar: barLook };
  if (type === "loop" || type === "foreach") return { kind: "frame", type, frame: frameLook };
  return { kind: "node", type, outline: nodeOutline(type) };
};

export const barPreview = { width: 22, height: 60, reach: 28, rows: [10, 30, 50] } as const;

export const framePreview = { width: w, height: 56 } as const;

const previewPad = 4;

const previewSize = (type: NodeType | "note") => {
  const preview = previewOf(type);
  switch (preview.kind) {
    case "node":
      return nodeLook(preview.type).box;
    case "bar":
      return { width: barPreview.width + barPreview.reach, height: barPreview.height };
    case "frame":
    case "note":
      return framePreview;
  }
};

export const previewViewBox = (type: NodeType | "note"): string => {
  const { width, height } = previewSize(type);
  return `${-previewPad} ${-previewPad} ${width + 2 * previewPad} ${height + 2 * previewPad}`;
};
