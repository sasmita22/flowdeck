import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../../../src/app/renderer/theme.css", import.meta.url), "utf8");

const rootBlock = css.slice(css.indexOf(":root {"), css.indexOf("}", css.indexOf(":root {")));

const token = (name: string) => new RegExp(`${name}:\\s*([^;]+);`).exec(rootBlock)?.[1];

describe("theme type scale", () => {
  it.each([
    ["--fs-2xs", "9.5px"],
    ["--fs-xs", "12px"],
    ["--fs-sm", "13px"],
    ["--fs-md", "14px"],
    ["--fs-lg", "16px"],
  ])("sets %s to %s", (name, size) => {
    expect(token(name)).toBe(size);
  });

  it("sizes chrome text only through the scale", () => {
    const outsideRoot = css.replace(rootBlock, "");
    expect(outsideRoot.match(/font(-size)?:[^;]*\d+(\.\d+)?px/g) ?? []).toEqual([]);
  });
});
