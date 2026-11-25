import type { Node } from "./schema.js";

export type Point = { x: number; y: number };

export type ExitSide = "right" | "bottom";

export type Bounds = { left: number; top: number; right: number; bottom: number };

export const EXIT_STUB = 12;

const HANDLE_TOP = 24;

export const wireEnds = (
  sender: Node,
  port: string,
  from: Bounds,
  to: Bounds,
): { source: Point; side: ExitSide; target: Point } => {
  const target = { x: to.left, y: to.top + HANDLE_TOP };
  if (sender.type === "branch" && port === "no")
    return { source: { x: (from.left + from.right) / 2, y: from.bottom }, side: "bottom", target };
  if (sender.type === "branch")
    return { source: { x: from.right, y: (from.top + from.bottom) / 2 }, side: "right", target };
  return { source: { x: from.right, y: from.top + HANDLE_TOP }, side: "right", target };
};

const labelLineHeight = 13;
const monoAdvance = 0.6 * 9.5;
const labelBorders = 2;
const labelPadding = 10;
const portLabelOffset = 3;
const labelGap = 4;

export const branchStub = (
  port: string,
  side: ExitSide,
  textWidth: (text: string) => number = (text) => text.length * monoAdvance,
): number => {
  const label =
    side === "right"
      ? textWidth(port) + labelPadding + labelBorders
      : labelLineHeight + labelBorders;
  const portLabel = portLabelOffset + (side === "right" ? textWidth(port) : labelLineHeight);
  return Math.ceil(2 * (portLabel + labelGap) + label);
};

type Wire = { source: Point; side: ExitSide; target: Point; stub?: number };

const curvature = 0.25;

const controlOffset = (distance: number) =>
  distance >= 0 ? 0.5 * distance : curvature * 25 * Math.sqrt(-distance);

const bezierOf = ({ source, side, target }: Wire): Point[] => [
  source,
  side === "right"
    ? { x: source.x + controlOffset(target.x - source.x), y: source.y }
    : { x: source.x, y: source.y + controlOffset(target.y - source.y) },
  { x: target.x - controlOffset(target.x - source.x), y: target.y },
  target,
];

const extentOf = (points: readonly Point[]): Bounds => ({
  left: Math.min(...points.map(({ x }) => x)),
  top: Math.min(...points.map(({ y }) => y)),
  right: Math.max(...points.map(({ x }) => x)),
  bottom: Math.max(...points.map(({ y }) => y)),
});

const touches = (a: Bounds, b: Bounds) =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

export const leavesRow = (from: Bounds, to: Bounds) =>
  !(from.top < to.bottom && to.top < from.bottom) || to.left < from.right;

export const goesBack = (from: Bounds, to: Bounds) => to.left < from.right && !touches(from, to);

export const clearOfEnds = (from: Bounds, to: Bounds) => (bounds: Bounds) =>
  !touches(bounds, from) && !touches(bounds, to);

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

export const isClear = (points: readonly Point[], obstacles: readonly Bounds[]) =>
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

export const routePath = (points: readonly Point[]): string =>
  points.map(({ x, y }, index) => `${index === 0 ? "M" : "L"} ${x} ${y}`).join(" ");
