import { describe, expect, it } from "vitest";
import { padded, type Bounds } from "../../../src/app/renderer/canvas/frames.js";
import {
  bezierCrosses,
  branchStub,
  containerWireEnds,
  routeContainerWire,
  routePath,
  routeWire,
  type ExitSide,
} from "../../../src/core/flow/wire-router.js";
import {
  pathCrossings,
  routeShapeProblems,
  rowsSpanned,
  type Point,
} from "../../app/renderer/canvas/canvas-geometry.js";

const at = (left: number, top: number, width = 170, height = 48): Bounds => ({
  left,
  top,
  right: left + width,
  bottom: top + height,
});

const outOf = (bounds: Bounds): Point => ({ x: bounds.right, y: bounds.top + 24 });

const inOf = (bounds: Bounds): Point => ({ x: bounds.left, y: bounds.top + 24 });

const bottomOf = (bounds: Bounds): Point => ({
  x: (bounds.left + bounds.right) / 2,
  y: bounds.bottom,
});

const row = (top: number, lefts: readonly number[]) => lefts.map((left) => at(left, top));

const columns = [0, 250, 500];

const cleanRoute = (
  wire: { source: Point; side: ExitSide; target: Point },
  obstacles: readonly Bounds[],
  frame: Bounds,
): Point[] => {
  const points = routeWire(wire, obstacles, frame);
  if (points === null) throw new Error("no route");
  expect(routeShapeProblems(points, wire.side)).toEqual([]);
  expect(points[0]).toEqual(wire.source);
  expect(points.at(-1)).toEqual(wire.target);
  expect(pathCrossings(points, obstacles)).toEqual([]);
  return points;
};

const segments = (points: readonly Point[]) =>
  points.slice(1).map((to, index) => ({ from: points[index] ?? to, to }));

const horizontals = (points: readonly Point[]) =>
  segments(points).filter(({ from, to }) => from.y === to.y && from.x !== to.x);

const verticals = (points: readonly Point[]) =>
  segments(points).filter(({ from, to }) => from.x === to.x && from.y !== to.y);

describe("wire-router", () => {
  describe("bezierCrosses", () => {
    const source = { x: 600, y: 124 };
    const target = { x: 0, y: 124 };

    it("is true for a level right-to-left wire over a box straddling its line", () => {
      expect(bezierCrosses(source, "right", target, [at(250, 100)])).toBe(true);
    });

    it("is false once that box is moved 200 px below the line", () => {
      expect(bezierCrosses(source, "right", target, [at(250, 300)])).toBe(false);
    });

    it("crosses a box just below the source only when the wire leaves downwards", () => {
      const below = { left: 280, top: 120, right: 320, bottom: 160 };
      const port = { x: 300, y: 100 };
      const ahead = { x: 600, y: 300 };

      expect(bezierCrosses(port, "bottom", ahead, [below])).toBe(true);
      expect(bezierCrosses(port, "right", ahead, [below])).toBe(false);
    });
  });

  describe("routeWire", () => {
    it("wraps a wire from the end of one row to the start of the next through the gap between them", () => {
      const [first, middle, last] = row(0, columns);
      const [next, ...rest] = row(200, columns);
      if (first === undefined || middle === undefined || last === undefined || next === undefined)
        throw new Error("rows");
      const obstacles = [first, middle, ...rest];
      const frame = padded([first, middle, last, next, ...rest]);

      const points = cleanRoute(
        { source: outOf(last), side: "right", target: inOf(next) },
        obstacles,
        frame,
      );

      const run = horizontals(points).sort(
        (a, b) => Math.abs(b.to.x - b.from.x) - Math.abs(a.to.x - a.from.x),
      )[0];
      expect(run?.from.y).toBeGreaterThan(last.bottom);
      expect(run?.from.y).toBeLessThan(next.top);
    });

    it("reaches a target two full rows down through a side lane inside the frame", () => {
      const top = row(0, columns);
      const full = [...row(200, columns), ...row(400, columns)];
      const [target, ...bottomRest] = row(600, columns);
      const sender = top.at(-1);
      if (sender === undefined || target === undefined) throw new Error("rows");
      const obstacles = [...top.slice(0, -1), ...full, ...bottomRest];
      const frame = padded([...top, ...full, target, ...bottomRest]);
      const extent = {
        left: Math.min(...obstacles.map(({ left }) => left)),
        right: Math.max(...obstacles.map(({ right }) => right)),
      };

      const points = cleanRoute(
        { source: outOf(sender), side: "right", target: inOf(target) },
        obstacles,
        frame,
      );

      const inLane = (x: number) =>
        x > frame.left && x < frame.right && (x < extent.left || x > extent.right);
      for (const band of [200, 400])
        expect(
          verticals(points).some(
            ({ from, to }) =>
              inLane(from.x) && Math.min(from.y, to.y) < band && Math.max(from.y, to.y) > band + 48,
          ),
        ).toBe(true);
    });

    it("passes full rows only in a side lane, never down a gap between aligned columns", () => {
      const [left, sender, right] = row(0, columns);
      const full = [...row(200, columns), ...row(400, columns)];
      const [first, target, last] = row(600, columns);
      if ([left, sender, right, first, target, last].includes(undefined)) throw new Error("rows");
      const obstacles = [left, right, ...full, first, last] as Bounds[];
      const frame = padded([...obstacles, sender as Bounds, target as Bounds]);
      const end = inOf(target as Bounds);
      expect(end.x - 12).toBeGreaterThan((first as Bounds).right);

      const points = cleanRoute(
        { source: outOf(sender as Bounds), side: "right", target: end },
        obstacles,
        frame,
      );

      expect(rowsSpanned(points, obstacles, frame)).toEqual([]);
    });

    it("finds a channel past a crossed row made of two groups at different heights", () => {
      const sender = at(1594, 227, 116);
      const target = at(314, 700);
      const senderRow = row(227, [314, 634, 954, 1274]);
      const upper = row(429, [634, 954]);
      const lower = row(560, [314, 634, 954, 1274, 1594]);
      const obstacles = [...senderRow, ...upper, ...lower];
      const frame = padded([sender, target, ...obstacles]);

      const points = cleanRoute(
        { source: outOf(sender), side: "right", target: inOf(target) },
        obstacles,
        frame,
      );

      expect(pathCrossings(points, upper)).toEqual([]);
      expect(pathCrossings(points, lower)).toEqual([]);
    });

    it("goes upwards to a target one row above the sender", () => {
      const sender = at(314, 758, 116);
      const target = at(900, 627);
      const senderRow = row(758, [580, 900]);
      const rowAbove = row(420, [314, 634, 954]);
      const obstacles = [...senderRow, ...rowAbove];
      const frame = padded([sender, target, ...obstacles]);
      const source = outOf(sender);
      const end = inOf(target);
      expect(end.y - source.y).toBe(-131);

      const points = cleanRoute({ source, side: "right", target: end }, obstacles, frame);

      expect(verticals(points).some(({ from, to }) => to.y < from.y)).toBe(true);
    });

    describe("stays between its two rows when the nearest channel lies behind the wire", () => {
      const upper = row(200, columns);
      const lower = row(700, columns);
      const obstacles = [...row(0, columns), ...upper, ...row(500, columns), ...lower];
      const frame = padded(obstacles);
      const middleOf = (boxes: readonly Bounds[]) => {
        const middle = boxes[1];
        if (middle === undefined) throw new Error("rows");
        return middle;
      };

      it.each([
        ["down", middleOf(upper), middleOf(lower)],
        ["up", middleOf(lower), middleOf(upper)],
      ])("going %s", (_, sender, receiver) => {
        const source = outOf(sender);
        const target = inOf(receiver);

        const points = cleanRoute({ source, side: "right", target }, obstacles, frame);

        const ys = points.map(({ y }) => y);
        expect(Math.min(...ys)).toBe(Math.min(source.y, target.y));
        expect(Math.max(...ys)).toBe(Math.max(source.y, target.y));
      });
    });

    it("takes a longer lane that stays between the rows over a shorter one that turns back", () => {
      const [, , sender] = row(0, columns);
      const [, , target] = row(300, columns);
      if (sender === undefined || target === undefined) throw new Error("rows");
      const obstacles = [...row(0, [...columns, 750]), ...row(100, [0, 250]), ...row(300, columns)];
      const frame = padded(obstacles);
      const source = outOf(sender);
      const end = inOf(target);

      const points = cleanRoute({ source, side: "right", target: end }, obstacles, frame);

      const ys = points.map(({ y }) => y);
      expect(Math.min(...ys)).toBe(source.y);
      expect(Math.max(...ys)).toBe(end.y);
    });

    it("takes a lane between the rows over a shorter direct route that turns back", () => {
      const sender = at(260, 0);
      const target = at(6, 600);
      const obstacles = [
        ...[at(0, 0), sender, at(560, 80)],
        ...[at(0, 300), at(190, 300)],
        ...[target, at(260, 600)],
      ];
      const frame = padded(obstacles);
      const source = outOf(sender);
      const end = inOf(target);

      const points = cleanRoute({ source, side: "right", target: end }, obstacles, frame);

      const ys = points.map(({ y }) => y);
      expect(Math.min(...ys)).toBe(source.y);
      expect(Math.max(...ys)).toBe(end.y);
    });

    it("arrives through the gap just above the target's row", () => {
      const box = (left: number, top: number, width = 150) => at(left, top, width, 48);
      const sender = box(214, 324);
      const target = box(30, 924);
      const obstacles = [
        ...[24, 324, 624].flatMap((top) => [box(24, top), box(214, top)]),
        box(420, 210, 100),
        box(420, 400, 100),
        target,
        box(220, 924),
      ];
      const frame = { left: 0, top: 0, right: 544, bottom: 972 };

      const points = cleanRoute(
        { source: outOf(sender), side: "right", target: inOf(target) },
        obstacles,
        frame,
      );

      expect(points.at(-3)?.y).toBe(798);
    });

    it("turns back through the nearer channel when none lies between the rows", () => {
      const sender = { left: 431, top: 409, right: 515, bottom: 440 };
      const target = { left: 254, top: 380, right: 317, bottom: 442 };
      const obstacles = [
        sender,
        target,
        { left: 731, top: 422, right: 804, bottom: 491 },
        { left: 54, top: 467, right: 247, bottom: 553 },
        { left: 552, top: 190, right: 627, bottom: 235 },
      ];
      const source = { x: sender.right, y: 424 };
      const end = { x: target.left, y: 411 };

      const points = cleanRoute(
        { source, side: "right", target: end },
        obstacles,
        padded(obstacles),
      );

      expect(Math.max(...points.map(({ y }) => y))).toBe(454.5);
    });

    describe("keeps a lane route's channels between the two ends", () => {
      const box = (left: number, top: number, right: number, bottom: number): Bounds => ({
        left,
        top,
        right,
        bottom,
      });

      it.each([
        {
          boxes: [box(820, 486, 946, 556), box(405, 556, 544, 640), box(654, 485, 768, 554)],
          more: [box(194, 479, 362, 514)],
          source: { x: 544, y: 598 },
          target: { x: 820, y: 521 },
        },
        {
          boxes: [box(798, 451, 925, 501), box(845, 52, 937, 88), box(635, 414, 754, 496)],
          more: [box(3, 254, 197, 342), box(394, 87, 495, 125), box(139, 127, 310, 169)],
          source: { x: 197, y: 298 },
          target: { x: 798, y: 476 },
        },
      ])("from $source.y to $target.y", ({ boxes, more, source, target }) => {
        const obstacles = [...boxes, ...more];

        const points = cleanRoute({ source, side: "right", target }, obstacles, padded(obstacles));

        const ys = points.map(({ y }) => y);
        expect(Math.min(...ys)).toBe(Math.min(source.y, target.y));
        expect(Math.max(...ys)).toBe(Math.max(source.y, target.y));
      });

      it("falls back to arriving on the sender's side of the target's row", () => {
        const obstacles = [
          box(608, 232, 742, 275),
          box(59, 492, 149, 537),
          box(466, 658, 608, 701),
        ];

        const points = cleanRoute(
          { source: { x: 537, y: 701 }, side: "bottom", target: { x: 608, y: 253 } },
          obstacles,
          padded(obstacles),
        );

        expect(points.at(-3)?.y).toBe(466.5);
      });

      it("falls back to leaving on the target's side of the sender's row", () => {
        const obstacles = [box(673, 25, 837, 99), box(226, 295, 387, 362), box(411, 117, 525, 191)];

        const points = cleanRoute(
          { source: { x: 525, y: 154 }, side: "right", target: { x: 673, y: 62 } },
          obstacles,
          padded(obstacles),
        );

        expect(points[2]).toEqual({ x: 537, y: 59 });
      });
    });

    describe("with a free run from the sender's row to a side lane", () => {
      const [, , sender] = row(0, columns);
      const [, , target] = row(400, columns);
      if (sender === undefined || target === undefined) throw new Error("rows");
      const obstacles = [...row(0, columns), ...row(200, [...columns, 750]), ...row(400, columns)];
      const frame = padded(obstacles);
      const wire = { source: outOf(sender), side: "right" as const, target: inOf(target) };

      it("runs straight out of the sender's row into the lane", () => {
        const [, turn] = cleanRoute(wire, obstacles, frame);

        expect(turn?.y).toBe(wire.source.y);
        expect(turn?.x).toBeGreaterThan(frame.right - 24);
      });

      it("takes the shorter of the two side lanes", () => {
        const points = cleanRoute(wire, obstacles, frame);

        expect(Math.min(...points.map(({ x }) => x))).toBe(wire.target.x - 12);
      });
    });

    it("leaves a bottom port downwards", () => {
      const sender = at(314, 758, 116);
      const target = at(314, 956);
      const between = row(880, [580, 900]);
      const frame = padded([sender, target, ...between]);

      cleanRoute(
        { source: bottomOf(sender), side: "bottom", target: inOf(target) },
        between,
        frame,
      );
    });

    it("returns null when the stub reaches past the frame on the only way out", () => {
      const obstacles = [...row(0, columns), ...row(200, columns)];
      const sender = obstacles.at(-1);
      const target = obstacles[0];
      if (sender === undefined || target === undefined) throw new Error("rows");
      const frame = padded(obstacles);
      const stub = frame.right - sender.right + 18;

      expect(
        routeWire(
          { source: outOf(sender), side: "right", target: inOf(target), stub },
          obstacles,
          frame,
        ),
      ).toBeNull();
    });

    it("leaves straight out of its row on a wire going up", () => {
      const obstacles = [
        { left: 536, top: 62, right: 717, bottom: 130 },
        { left: 23, top: 127, right: 140, bottom: 181 },
        { left: 425, top: 286, right: 561, bottom: 324 },
      ];
      const source = { x: 561, y: 305 };
      const frame = padded(obstacles);

      const points = cleanRoute(
        { source, side: "right", target: { x: 536, y: 96 } },
        obstacles,
        frame,
      );

      expect(points[1]).toEqual({ x: frame.right - 12, y: source.y });
    });

    it("returns null when obstacles fill the frame and leave no channel", () => {
      const sender = at(500, 0);
      const target = at(0, 400);
      const frame = padded([sender, target]);
      const wall = { left: frame.left - 50, top: 150, right: frame.right + 50, bottom: 250 };

      expect(
        routeWire({ source: outOf(sender), side: "right", target: inOf(target) }, [wall], frame),
      ).toBeNull();
    });
  });

  describe("container wires", () => {
    const workspace = { left: 500, top: 0, right: 800, bottom: 120 };
    const session = { left: 0, top: 200, right: 700, bottom: 450 };
    const rows = [...row(224, [24, 250, 476]), ...row(378, [24, 250, 476])];
    const start = at(-200, 36, 48, 48);
    const stop = at(900, 300, 48, 48);

    it("leaves a frame at its right middle and enters a frame at its left middle", () => {
      expect(
        containerWireEnds({ bounds: workspace, frame: true }, { bounds: session, frame: true }),
      ).toEqual({ source: { x: 800, y: 60 }, side: "right", target: { x: 0, y: 325 } });
    });

    it("ends a node end where a node wire ends, and a frame end on the frame", () => {
      expect(
        containerWireEnds({ bounds: start, frame: false }, { bounds: workspace, frame: true }),
      ).toEqual({ source: { x: -152, y: 60 }, side: "right", target: { x: 500, y: 60 } });
      expect(
        containerWireEnds({ bounds: session, frame: true }, { bounds: stop, frame: false }),
      ).toEqual({ source: { x: 700, y: 325 }, side: "right", target: { x: 900, y: 324 } });
    });

    const ends = { source: { x: 800, y: 60 }, target: { x: 0, y: 325 } };

    it("routes a frame to the frame below it around the rows and both frames", () => {
      const points = routeContainerWire({
        ...ends,
        sourceFrame: workspace,
        targetFrame: session,
        boxes: rows,
        bounds: { left: -32, top: -32, right: 832, bottom: 482 },
      });

      if (points === null) throw new Error("no route");
      expect(points[0]).toEqual(ends.source);
      expect(points.at(-1)).toEqual(ends.target);
      expect(pathCrossings(points, [...rows, workspace, session])).toEqual([]);
    });

    it("finds no route when the bounds leave no lane outside the frames", () => {
      expect(
        routeContainerWire({
          ...ends,
          sourceFrame: workspace,
          targetFrame: session,
          boxes: rows,
          bounds: { left: 0, top: 0, right: 800, bottom: 450 },
        }),
      ).toBeNull();
    });
  });

  describe("routePath", () => {
    it("draws straight lines through the points in order", () => {
      expect(
        routePath([
          { x: 0, y: 0 },
          { x: 12, y: 0 },
          { x: 12, y: 50 },
        ]),
      ).toBe("M 0 0 L 12 0 L 12 50");
    });
  });

  describe("branchStub", () => {
    it("measures the port label at a fixed monospace advance by default", () => {
      expect(branchStub("no", "right")).toBe(61);
    });

    it("measures the port label with the width it is given", () => {
      expect(branchStub("no", "right", (text) => (text === "no" ? 20 : 0))).toBe(86);
    });
  });
});
