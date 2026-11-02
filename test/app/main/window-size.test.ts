import { describe, expect, it } from "vitest";
import { defaultWindowBounds, minimumWindowSize } from "../../../src/app/main/window-size.js";

const area = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });

describe("defaultWindowBounds", () => {
  it.each([
    ["a wide display below the menu bar", area(0, 25, 3440, 1410), area(344, 166, 2752, 1128)],
    ["a 1080p display", area(0, 0, 1920, 1080), area(192, 108, 1536, 864)],
    ["a work area whose 80% is under the minimum", area(0, 0, 1000, 700), area(20, 30, 960, 640)],
    ["a work area smaller than the minimum", area(0, 0, 900, 600), area(0, 0, 900, 600)],
    ["an odd size, rounded", area(0, 0, 2001, 1001), area(200, 100, 1601, 801)],
    ["a second display to the right", area(3440, 0, 1920, 1080), area(3632, 108, 1536, 864)],
  ])("opens at 80%% of %s, centred", (_name, workArea, expected) => {
    expect(defaultWindowBounds(workArea)).toEqual(expected);
  });
});

describe("minimumWindowSize", () => {
  it("is 960x640 on a work area that fits it", () => {
    expect(minimumWindowSize(area(0, 0, 1920, 1080))).toEqual({ width: 960, height: 640 });
  });

  it("is the work area where it is smaller", () => {
    expect(minimumWindowSize(area(0, 0, 900, 600))).toEqual({ width: 900, height: 600 });
  });
});
