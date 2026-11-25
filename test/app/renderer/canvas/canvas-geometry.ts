import { moveNodes } from "../../../../src/app/renderer/canvas/commands.js";
import {
  boundsOf,
  FRAME_PADDING,
  type Bounds,
} from "../../../../src/app/renderer/canvas/frames.js";
import { tidyMoves } from "../../../../src/app/renderer/canvas/layout.js";
import { toViewNodes } from "../../../../src/app/renderer/canvas/view.js";
import type { Flow } from "../../../../src/core/flow/schema.js";

export type Point = { x: number; y: number };

export const canvas = { width: 1600, height: 1000 };

export const tidied = async (source: Flow, size = canvas): Promise<Flow> =>
  moveNodes(await tidyMoves(source, size)).do(source);

export const drawnBoxes = (current: Flow): Map<string, Bounds> => {
  const view = new Map(toViewNodes(current, [], {}, null).map((node) => [node.id, node]));
  return new Map(
    current.nodes.map((node) => {
      const drawn = view.get(node.id);
      const isBar = node.type === "fork" || node.type === "join";
      if (!isBar || drawn?.width === undefined || drawn.height === undefined)
        return [node.id, boundsOf(node)];
      const { x, y } = drawn.position;
      return [node.id, { left: x, top: y, right: x + drawn.width, bottom: y + drawn.height }];
    }),
  );
};

export const overlaps = (a: Bounds, b: Bounds) =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

export const box = (boxes: Map<string, Bounds>, id: string): Bounds => {
  const found = boxes.get(id);
  if (found === undefined) throw new Error(`no box for ${id}`);
  return found;
};

const segmentCrosses = (from: Point, to: Point, bounds: Bounds): boolean => {
  if (from.x !== to.x && from.y !== to.y)
    throw new Error(`diagonal segment (${from.x}, ${from.y}) -> (${to.x}, ${to.y})`);
  const low = { x: Math.min(from.x, to.x), y: Math.min(from.y, to.y) };
  const high = { x: Math.max(from.x, to.x), y: Math.max(from.y, to.y) };
  if (from.y === to.y)
    return (
      bounds.top < from.y && from.y < bounds.bottom && low.x < bounds.right && bounds.left < high.x
    );
  return (
    bounds.left < from.x && from.x < bounds.right && low.y < bounds.bottom && bounds.top < high.y
  );
};

export const pathCrossings = (points: readonly Point[], boxes: readonly Bounds[]): Bounds[] =>
  boxes.filter((bounds) =>
    points.slice(1).some((to, index) => segmentCrosses(points[index] ?? to, to, bounds)),
  );

export const routeShapeProblems = (
  points: readonly Point[],
  side: "right" | "bottom",
): string[] => {
  if (points.length < 4) return [`has ${points.length} points, needs at least 4`];
  const problems = points.slice(1).flatMap((to, index) => {
    const from = points[index] ?? to;
    return from.x === to.x || from.y === to.y ? [] : [`segment ${index} is not axis-aligned`];
  });
  const [first, second] = points;
  const exits =
    first !== undefined &&
    second !== undefined &&
    (side === "right"
      ? second.y === first.y && second.x > first.x
      : second.x === first.x && second.y > first.y);
  const before = points.at(-2);
  const last = points.at(-1);
  const enters =
    before !== undefined && last !== undefined && before.y === last.y && last.x > before.x;
  return [
    ...problems,
    ...(exits ? [] : [`first segment does not run ${side === "right" ? "right" : "down"}`]),
    ...(enters ? [] : ["last segment does not run rightwards into the last point"]),
  ];
};

export const obstaclesFor = (
  boxes: Map<string, Bounds>,
  sourceId: string,
  targetId: string,
): Bounds[] => {
  const ends = [box(boxes, sourceId), box(boxes, targetId)];
  return [...boxes]
    .filter(([id]) => id !== sourceId && id !== targetId)
    .map(([, bounds]) => bounds)
    .filter((bounds) => !ends.some((end) => overlaps(bounds, end)));
};

export const rowsSpanned = (
  points: readonly Point[],
  rows: readonly Bounds[],
  frame: Bounds,
): string[] => {
  const inLane = (x: number) => x < frame.left + FRAME_PADDING || x > frame.right - FRAME_PADDING;
  const spans = points.slice(1).flatMap((to, index) => {
    const from = points[index] ?? to;
    if (from.x !== to.x || inLane(from.x)) return [];
    const low = Math.min(from.y, to.y);
    const high = Math.max(from.y, to.y);
    return rows
      .filter(({ top, bottom }) => low < top && bottom < high)
      .map(
        ({ top, bottom }) => `x=${from.x} from y=${low} to ${high} spans the row ${top}-${bottom}`,
      );
  });
  return [...new Set(spans)];
};
