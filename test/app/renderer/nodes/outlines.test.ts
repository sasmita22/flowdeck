import { describe, expect, it } from "vitest";
import { paletteItems } from "../../../../src/app/renderer/canvas/palette-items.js";
import {
  barLook,
  frameLook,
  nodeOutline,
  previewOf,
  previewViewBox,
} from "../../../../src/app/renderer/nodes/outlines.js";
import type { NodeType } from "../../../../src/core/flow/schema.js";

const bars = ["fork", "join"] as const;
const frames = ["loop", "foreach"] as const;
const shaped = paletteItems
  .map(({ type }) => type)
  .filter(
    (type): type is Exclude<NodeType, "fork" | "join"> =>
      !(bars as readonly string[]).includes(type) && !(frames as readonly string[]).includes(type),
  );

describe("previewOf", () => {
  it.each(shaped)("routes %s to its outline preview", (type) => {
    expect(previewOf(type)).toEqual({ kind: "node", type, outline: nodeOutline(type) });
    expect(nodeOutline(type).path).toMatch(/^M.* Z$/);
  });

  it.each(bars)("previews %s as the canvas bar", (type) => {
    expect(previewOf(type)).toEqual({ kind: "bar", type, bar: barLook });
  });

  it.each(frames)("previews %s as the canvas body frame", (type) => {
    expect(previewOf(type)).toEqual({ kind: "frame", type, frame: frameLook });
  });
});

describe("previewViewBox", () => {
  it.each([
    ...shaped
      .filter((type) => type !== "ask" && type !== "branch")
      .map((type) => [type, 178, 56] as const),
    ["ask", 178, 65],
    ["branch", 124, 56],
    ["fork", 58, 68],
    ["join", 58, 68],
    ["loop", 178, 64],
    ["foreach", 178, 64],
  ] as const)("crops %s to its own shape plus padding", (type, width, height) => {
    expect(previewViewBox(type)).toBe(`-4 -4 ${width} ${height}`);
  });
});

describe("nodeOutline", () => {
  it("rounds the trigger's left end and the output's right end", () => {
    expect(nodeOutline("trigger").path).toContain("A24,24 0 0 1 24,0");
    expect(nodeOutline("output").path).toContain("A24,24 0 0 1 146,48");
  });

  it("gives the agent its inner ring, the gate its two posts and the branch its hexagon fill", () => {
    expect(nodeOutline("agent").extras.map(({ element }) => element)).toEqual(["path"]);
    expect(nodeOutline("gate").extras.map(({ element }) => element)).toEqual(["rect", "rect"]);
    expect(nodeOutline("branch").extras.map(({ element }) => element)).toEqual(["polygon"]);
  });

  it("draws the script as a terminal box with terminal ink", () => {
    expect(nodeOutline("script")).toMatchObject({
      fill: "var(--term-bg)",
      ink: "var(--term-fg)",
      strokeWidth: 1,
    });
  });
});
