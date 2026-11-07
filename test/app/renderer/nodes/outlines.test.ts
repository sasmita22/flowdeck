import { describe, expect, it } from "vitest";
import { paletteItems } from "../../../../src/app/renderer/canvas/palette-items.js";
import { noteLook } from "../../../../src/app/renderer/nodes/note-look.js";
import {
  barLook,
  framePreview,
  frameLook,
  nodeOutline,
  previewOf,
  previewViewBox,
} from "../../../../src/app/renderer/nodes/outlines.js";
import type { NodeType } from "../../../../src/core/flow/schema.js";

const bars = ["fork", "join"] as const;
const rightmostX = (path: string): number =>
  Math.max(
    ...[...path.matchAll(/(-?[\d.]+),-?[\d.]+/g)].map(([, x]) => Number(x)),
    ...[...path.matchAll(/H(-?[\d.]+)/g)].map(([, x]) => Number(x)),
  );
const frames = ["loop", "foreach"] as const;
const shaped = paletteItems
  .map(({ type }) => type)
  .filter(
    (type): type is Exclude<NodeType, "fork" | "join"> =>
      type !== "note" &&
      !(bars as readonly string[]).includes(type) &&
      !(frames as readonly string[]).includes(type),
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

  it("previews the note as a note card in the note's own colours", () => {
    expect(previewOf("note")).toEqual({ kind: "note", type: "note", note: noteLook });
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
    ["note", 178, 64],
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

  it.each(["loop", "foreach"] as const)("draws a widened %s label as wide as its box", (type) => {
    expect(nodeOutline(type).path).toContain("H166 Q170,0 170,4");
    expect(nodeOutline(type, 281).path).toContain("H277 Q281,0 281,4");
    expect(nodeOutline(type, 281).path).not.toContain("170");
  });

  it("builds the agent outline from the width it is given", () => {
    expect(nodeOutline("agent", 300).path).toContain("H288 Q300,0 300,12");
    expect(nodeOutline("agent").path).toContain("H158 Q170,0 170,12");
  });

  it.each(shaped.filter((type) => type !== "output"))(
    "ends a %s outline 300 wide at x = 300",
    (type) => {
      expect(rightmostX(nodeOutline(type, 300).path)).toBe(300);
    },
  );

  it("rounds a 300-wide output's right end at x = 300", () => {
    expect(nodeOutline("output", 300).path).toContain("A24,24 0 0 1 276,48");
  });

  it("draws the agent's ring, the gate's right post and the branch fill at the width", () => {
    const attributesOf = (type: "agent" | "gate" | "branch", index: number) =>
      nodeOutline(type, 300).extras[index]?.attributes ?? {};
    expect(rightmostX(String(attributesOf("agent", 0)["d"]))).toBe(296.5);
    expect(attributesOf("gate", 1)["x"]).toBe(295);
    expect(rightmostX(String(attributesOf("branch", 0)["points"]))).toBe(300);
  });

  it("draws the palette previews at the base width", () => {
    expect(framePreview.width).toBe(170);
    expect(previewOf("agent")).toEqual({
      kind: "node",
      type: "agent",
      outline: nodeOutline("agent", 170),
    });
  });

  it("draws the script as a terminal box with terminal ink", () => {
    expect(nodeOutline("script")).toMatchObject({
      fill: "var(--term-bg)",
      ink: "var(--term-fg)",
      strokeWidth: 1,
    });
  });
});
