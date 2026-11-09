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
const circles = ["trigger", "output"] as const;
const isCircle = (path: string, radius: number, centre = 24): boolean => {
  if (!/^[MAZ\d\s,.-]+$/.test(path)) return false;
  const commands = [...path.matchAll(/([MAZ])([^MAZ]*)/g)].map(([, letter, args]) => ({
    letter,
    numbers: (args?.match(/-?[\d.]+/g) ?? []).map(Number),
  }));
  const onCircle = (x: number | undefined, y: number | undefined) =>
    x !== undefined &&
    y !== undefined &&
    Math.abs(Math.hypot(x - centre, y - centre) - radius) < 1e-6;
  const arcs = commands.filter(({ letter }) => letter === "A");
  return (
    commands[0]?.letter === "M" &&
    onCircle(commands[0].numbers[0], commands[0].numbers[1]) &&
    arcs.length >= 2 &&
    arcs.every(
      ({ numbers }) =>
        numbers.length === 7 &&
        numbers[0] === radius &&
        numbers[1] === radius &&
        onCircle(numbers[5], numbers[6]),
    )
  );
};
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
      .filter((type) => !["ask", "branch", "trigger", "output"].includes(type))
      .map((type) => [type, 178, 56] as const),
    ["trigger", 56, 56],
    ["output", 56, 56],
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
  it.each(circles)("draws %s as a circle of diameter 48", (type) => {
    expect(isCircle(nodeOutline(type).path, 24)).toBe(true);
  });

  it("gives the trigger circle no extras", () => {
    expect(nodeOutline("trigger").extras).toEqual([]);
  });

  it("gives the output circle a 3 px stroke and one inner ring inset 5 px", () => {
    const { strokeWidth, extras } = nodeOutline("output");
    expect(strokeWidth).toBe(3);
    expect(extras).toHaveLength(1);
    expect(extras[0]?.element).toBe("path");
    expect(isCircle(String(extras[0]?.attributes["d"]), 19)).toBe(true);
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

  it.each(shaped.filter((type) => !(circles as readonly string[]).includes(type)))(
    "ends a %s outline 300 wide at x = 300",
    (type) => {
      expect(rightmostX(nodeOutline(type, 300).path)).toBe(300);
    },
  );

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
