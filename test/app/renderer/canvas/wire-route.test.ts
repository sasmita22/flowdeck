import { describe, expect, it } from "vitest";
import { labelPoint, snapRoute } from "../../../../src/app/renderer/canvas/wire-route.js";
import { routeShapeProblems } from "./canvas-geometry.js";

describe("wire-route", () => {
  describe("labelPoint", () => {
    it("is the midpoint of the first segment", () => {
      expect(
        labelPoint([
          { x: 0, y: 0 },
          { x: 12, y: 0 },
          { x: 12, y: 50 },
          { x: 40, y: 50 },
        ]),
      ).toEqual({ x: 6, y: 0 });
    });
  });

  describe("snapRoute", () => {
    const route = [
      { x: 100, y: 24 },
      { x: 112, y: 24 },
      { x: 112, y: 100 },
      { x: -12, y: 100 },
      { x: -12, y: 224 },
      { x: 0, y: 224 },
    ];

    it("moves the ends to the live handles and keeps every segment axis-aligned", () => {
      const snapped = snapRoute(route, { sourceX: 105, sourceY: 30, targetX: 3, targetY: 231 });

      expect(snapped).toEqual([
        { x: 105, y: 30 },
        { x: 112, y: 30 },
        { x: 112, y: 100 },
        { x: -12, y: 100 },
        { x: -12, y: 231 },
        { x: 3, y: 231 },
      ]);
      expect(routeShapeProblems(snapped, "right")).toEqual([]);
    });
  });
});
