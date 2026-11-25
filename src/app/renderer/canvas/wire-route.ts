import { getBezierPath, Position } from "@xyflow/react";
import type { Bounds } from "./frames.js";
import { renderedWidth } from "./text-measure.js";

export type Point = { x: number; y: number };

export type ExitSide = "right" | "bottom";

export const EXIT_STUB = 12;

const labelFont = "600 var(--fs-2xs) var(--f-mono)";
const labelLineHeight = 13;
const monoAdvance = 0.6 * 9.5;
const labelBorders = 2;
const labelPadding = 10;
const portLabelOffset = 3;
const labelGap = 4;

const textSpan = (text: string) => renderedWidth(text, labelFont) ?? text.length * monoAdvance;

export const branchStub = (port: string, side: ExitSide): number => {
  const label =
    side === "right"
      ? textSpan(port) + labelPadding + labelBorders
      : labelLineHeight + labelBorders;
  const portLabel = portLabelOffset + (side === "right" ? textSpan(port) : labelLineHeight);
  return Math.ceil(2 * (portLabel + labelGap) + label);
};

type Wire = { source: Point; side: ExitSide; target: Point; stub?: number };

type LiveEnds = { sourceX: number; sourceY: number; targetX: number; targetY: number };

const numberPattern = /-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/gi;

const bezierOf = ({ source, side, target }: Wire): Point[] => {
  const [path] = getBezierPath({
    sourceX: source.x,
    sourceY: source.y,
    sourcePosition: side === "right" ? Position.Right : Position.Bottom,
    targetX: target.x,
    targetY: target.y,
    targetPosition: Position.Left,
  });
  const values = (path.match(numberPattern) ?? []).map(Number);
  const at = (index: number): number => {
    const value = values[index];
    if (value === undefined) throw new Error(`unexpected bezier path ${path}`);
    return value;
  };
  return [0, 2, 4, 6].map((index) => ({ x: at(index), y: at(index + 1) }));
};

const extentOf = (points: readonly Point[]): Bounds => ({
  left: Math.min(...points.map(({ x }) => x)),
  top: Math.min(...points.map(({ y }) => y)),
  right: Math.max(...points.map(({ x }) => x)),
  bottom: Math.max(...points.map(({ y }) => y)),
});

const touches = (a: Bounds, b: Bounds) =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

const strictlyInside = ({ x, y }: Point, { left, top, right, bottom }: Bounds) =>
  left < x && x < right && top < y && y < bottom;

const distance = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y);

const sampleSpacing = 8;

export const bezierCrosses = (
  source: Point,
  side: ExitSide,
  target: Point,
  obstacles: readonly Bounds[],
): boolean => {
  const controls = bezierOf({ source, side, target });
  const hull = extentOf(controls);
  const near = obstacles.filter((obstacle) => touches(obstacle, hull));
  if (near.length === 0) return false;
  const [p0, p1, p2, p3] = controls as [Point, Point, Point, Point];
  const steps = Math.max(
    16,
    Math.ceil((distance(p0, p1) + distance(p1, p2) + distance(p2, p3)) / sampleSpacing),
  );
  for (let step = 1; step < steps; step += 1) {
    const t = step / steps;
    const u = 1 - t;
    const point = {
      x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
      y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
    };
    if (near.some((obstacle) => strictlyInside(point, obstacle))) return true;
  }
  return false;
};

const segmentCrosses = (from: Point, to: Point, { left, top, right, bottom }: Bounds) =>
  from.y === to.y
    ? top < from.y &&
      from.y < bottom &&
      Math.min(from.x, to.x) < right &&
      left < Math.max(from.x, to.x)
    : left < from.x &&
      from.x < right &&
      Math.min(from.y, to.y) < bottom &&
      top < Math.max(from.y, to.y);

const segmentsOf = (points: readonly Point[]) =>
  points.slice(1).map((to, index) => ({ from: points[index] ?? to, to }));

const isClear = (points: readonly Point[], obstacles: readonly Bounds[]) =>
  segmentsOf(points).every(({ from, to }) =>
    obstacles.every((obstacle) => !segmentCrosses(from, to, obstacle)),
  );

const collinear = (a: Point, b: Point, c: Point) =>
  (a.x === b.x && b.x === c.x) || (a.y === b.y && b.y === c.y);

const simplified = (points: readonly Point[]): Point[] =>
  points
    .filter((point, index) => {
      const before = points[index - 1];
      return before === undefined || before.x !== point.x || before.y !== point.y;
    })
    .reduce<Point[]>((kept, point) => {
      const last = kept.at(-1);
      const beforeLast = kept.at(-2);
      if (last !== undefined && beforeLast !== undefined && collinear(beforeLast, last, point))
        kept.pop();
      kept.push(point);
      return kept;
    }, []);

const withinFrame = (points: readonly Point[], frame: Bounds) =>
  points.every(
    ({ x, y }) => frame.left <= x && x <= frame.right && frame.top <= y && y <= frame.bottom,
  );

const channels = (column: readonly Bounds[], frame: Bounds, preferred?: number): number[] => {
  const ys: number[] = [];
  const add = (top: number, bottom: number) => {
    ys.push((top + bottom) / 2);
    if (preferred !== undefined && top < preferred && preferred < bottom) ys.push(preferred);
  };
  let free = frame.top;
  for (const { top, bottom } of column) {
    if (top > free) add(free, Math.min(top, frame.bottom));
    free = Math.max(free, bottom);
    if (free >= frame.bottom) return ys;
  }
  if (frame.bottom > free) add(free, frame.bottom);
  return ys;
};

const xExtentOf = (obstacles: readonly Bounds[], frame: Bounds) => ({
  left: Math.min(frame.right, ...obstacles.map((obstacle) => obstacle.left)),
  right: Math.max(frame.left, ...obstacles.map((obstacle) => obstacle.right)),
});

const lanes = ({ left, right }: { left: number; right: number }, frame: Bounds): number[] =>
  [(frame.left + left) / 2, (right + frame.right) / 2].filter(
    (x) => frame.left < x && x < frame.right && (x < left || x > right),
  );

const lengthOf = (points: readonly Point[]) =>
  segmentsOf(points).reduce(
    (sum, { from, to }) => sum + Math.abs(to.x - from.x) + Math.abs(to.y - from.y),
    0,
  );

const exitsTowards = (points: readonly Point[], side: ExitSide, stub: number) => {
  const [first, second] = points;
  if (first === undefined || second === undefined) return false;
  return side === "right"
    ? second.y === first.y && second.x >= first.x + stub
    : second.x === first.x && second.y >= first.y + stub;
};

const entersRightwards = (points: readonly Point[]) => {
  const before = points.at(-2);
  const last = points.at(-1);
  return before !== undefined && last !== undefined && before.y === last.y && last.x > before.x;
};

const nearestTowards = (y: number, towards: number, ys: readonly number[], aheadOnly: boolean) => {
  const behind = (candidate: number) => Number((candidate - y) * (towards - y) < 0);
  return ys
    .filter(
      (candidate) =>
        !aheadOnly || (Math.min(y, towards) <= candidate && candidate <= Math.max(y, towards)),
    )
    .sort((a, b) => behind(a) - behind(b) || Math.abs(a - y) - Math.abs(b - y));
};

export const routeWire = (
  wire: Wire,
  everywhere: readonly Bounds[],
  frame: Bounds,
): Point[] | null => {
  const { source, side, target, stub = EXIT_STUB } = wire;
  const obstacles = everywhere
    .filter((obstacle) => touches(obstacle, frame))
    .sort((a, b) => a.top - b.top);
  const extent = xExtentOf(obstacles, frame);
  const exit =
    side === "right" ? { x: source.x + stub, y: source.y } : { x: source.x, y: source.y + stub };
  const entry = { x: target.x - EXIT_STUB, y: target.y };
  const spansRow = (points: readonly Point[]) =>
    segmentsOf(points).some(({ from, to }) => {
      if (from.x !== to.x || from.x < extent.left || from.x > extent.right) return false;
      const low = Math.min(from.y, to.y);
      const high = Math.max(from.y, to.y);
      return obstacles.some(({ top, bottom }) => low < top && bottom < high);
    });
  const columnOver = (...xs: number[]) => {
    const low = Math.min(...xs);
    const high = Math.max(...xs);
    return obstacles.filter(({ left, right }) => left < high && low < right);
  };
  const firstFitting = (
    column: readonly Bounds[],
    ys: readonly number[],
    pointsAt: (y: number) => Point[],
    shaped: (points: readonly Point[]) => boolean,
  ): Point[] | undefined => {
    for (const y of ys) {
      const points = simplified(pointsAt(y));
      if (
        shaped(points) &&
        withinFrame(points, frame) &&
        isClear(points, column) &&
        !spansRow(points)
      )
        return points;
    }
    return undefined;
  };
  const directColumn = columnOver(source.x, exit.x, entry.x, target.x);
  const directCost = (y: number) => Math.abs(y - exit.y) + Math.abs(y - entry.y);
  const betweenRows = (y: number) =>
    Math.min(source.y, target.y) <= y && y <= Math.max(source.y, target.y);
  const directVia = (aheadOnly: boolean) => {
    const direct = firstFitting(
      directColumn,
      channels(directColumn, frame)
        .filter((y) => !aheadOnly || betweenRows(y))
        .sort((a, b) => directCost(a) - directCost(b)),
      (y) => [source, exit, { x: exit.x, y }, { x: entry.x, y }, entry, target],
      (points) =>
        points.length >= 4 && exitsTowards(points, side, stub) && entersRightwards(points),
    );
    return direct === undefined ? [] : [direct];
  };
  const viaLanes = (aheadOnly: boolean) =>
    lanes(extent, frame).flatMap((lane) => {
      const leavingColumn = columnOver(source.x, exit.x, lane);
      const leaving = firstFitting(
        leavingColumn,
        nearestTowards(source.y, target.y, channels(leavingColumn, frame, source.y), aheadOnly),
        (y) => [source, exit, { x: exit.x, y }, { x: lane, y }],
        (points) => exitsTowards(points, side, stub),
      );
      if (leaving === undefined) return [];
      const arrivingColumn = columnOver(lane, entry.x, target.x);
      const arriving = firstFitting(
        arrivingColumn,
        nearestTowards(target.y, source.y, channels(arrivingColumn, frame), aheadOnly),
        (y) => [{ x: lane, y }, { x: entry.x, y }, entry, target],
        entersRightwards,
      );
      return arriving === undefined ? [] : [simplified([...leaving, ...arriving])];
    });
  const fitting = (points: readonly Point[]) =>
    exitsTowards(points, side, stub) && entersRightwards(points);
  const among = (aheadOnly: boolean) =>
    [...directVia(aheadOnly), ...viaLanes(aheadOnly)].filter(fitting);
  const forward = among(true);
  const routes = forward.length > 0 ? forward : among(false);
  return routes.reduce<Point[] | null>(
    (best, points) =>
      best === null || lengthOf(points) + points.length < lengthOf(best) + best.length
        ? points
        : best,
    null,
  );
};

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

export const routePath = (points: readonly Point[]): string =>
  points.map(({ x, y }, index) => `${index === 0 ? "M" : "L"} ${x} ${y}`).join(" ");
