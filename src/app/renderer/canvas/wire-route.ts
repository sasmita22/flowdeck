import type { Point } from "../../../core/flow/wire-router.js";
import { renderedWidth } from "./text-measure.js";

const labelFont = "600 var(--fs-2xs) var(--f-mono)";
const monoAdvance = 0.6 * 9.5;

export const textSpan = (text: string) =>
  renderedWidth(text, labelFont) ?? text.length * monoAdvance;

type LiveEnds = { sourceX: number; sourceY: number; targetX: number; targetY: number };

export const labelPoint = ([first, second]: readonly Point[]): Point => {
  if (first === undefined || second === undefined) throw new Error("a route needs two points");
  return { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
};

export const snapRoute = (points: readonly Point[], live: LiveEnds): Point[] => {
  const last = points.length - 1;
  const [first, second] = points;
  const before = points[last - 1];
  const end = points[last];
  const startsLevel = first !== undefined && second !== undefined && first.y === second.y;
  const endsLevel = before !== undefined && end !== undefined && before.y === end.y;
  return points.map((point, index) => {
    if (index === 0) return { x: live.sourceX, y: live.sourceY };
    if (index === last) return { x: live.targetX, y: live.targetY };
    if (index === 1 && startsLevel) return { ...point, y: live.sourceY };
    if (index === 1) return { ...point, x: live.sourceX };
    if (index === last - 1 && endsLevel) return { ...point, y: live.targetY };
    if (index === last - 1) return { ...point, x: live.targetX };
    return point;
  });
};
