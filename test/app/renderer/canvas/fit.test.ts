import { describe, expect, it } from "vitest";
import {
  dotGap,
  openingViewport,
  snappedToDots,
  startViewport,
} from "../../../../src/app/renderer/canvas/fit.js";

describe("snappedToDots", () => {
  it("moves a 100% view onto the dot grid of the start view, so nodes draw on the same pixels", () => {
    const snapped = snappedToDots({ x: 24 + 5 * dotGap + 7.4, y: 56 - 3 * dotGap - 10, zoom: 1 });

    expect(snapped).toEqual({ x: 24 + 5 * dotGap, y: 56 - 4 * dotGap, zoom: 1 });
    expect((snapped.x - startViewport.x) % dotGap).toBe(0);
  });

  it("leaves a zoomed-out view as fitted", () => {
    const fitted = { x: 13.7, y: 4.2, zoom: 0.62 };

    expect(snappedToDots(fitted)).toEqual(fitted);
  });
});

describe("openingViewport", () => {
  const size = { width: 1000, height: 600 };

  it("keeps the start view when every node already shows in it", () => {
    expect(openingViewport({ x: 0, y: 0, width: 900, height: 500 }, size)).toEqual(startViewport);
  });

  it("fits nodes that the start view would leave off screen, never above 100%", () => {
    const fitted = openingViewport({ x: 0, y: 0, width: 1200, height: 800 }, size);

    expect(fitted.zoom).toBeLessThan(1);
    expect(fitted.x).toBeGreaterThanOrEqual(0);
  });

  it("brings a small flow far from the origin into view at 100%, on the dot grid", () => {
    const fitted = openingViewport({ x: 3000, y: 2000, width: 200, height: 100 }, size);

    expect(fitted.zoom).toBe(1);
    expect(Math.abs((fitted.x - startViewport.x) % dotGap)).toBe(0);
    expect(fitted.x + 3000).toBeGreaterThan(0);
    expect(fitted.x + 3200).toBeLessThan(size.width);
  });
});
