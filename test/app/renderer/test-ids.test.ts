import { describe, expect, it } from "vitest";
import {
  controlTestIds,
  paletteTestId,
  readoutTestIds,
} from "../../../src/app/renderer/test-ids.js";
import { NodeType } from "../../../src/core/flow/schema.js";

describe("test ids", () => {
  it.each(NodeType.options)("names the %s palette entry palette-<type>", (type) => {
    expect(paletteTestId(type)).toBe(`palette-${type}`);
  });

  it("names the note palette entry palette-note", () => {
    expect(paletteTestId("note")).toBe("palette-note");
  });

  it("keeps the ids the e2e specs drag exactly", () => {
    expect(paletteTestId("prompt")).toBe("palette-prompt");
    expect(paletteTestId("script")).toBe("palette-script");
  });

  it("lists every control id", () => {
    expect(Object.values(controlTestIds)).toEqual([
      "canvas-save",
      "canvas-run",
      "menu-more",
      "terminal-open",
      "menu-terminal-close",
      "sidebar-hide",
      "sidebar-show",
      "inspector-hide",
      "inspector-show",
      "canvas-undo",
      "canvas-redo",
      "canvas-delete",
      "canvas-wrap",
      "canvas-zoom-in",
      "canvas-zoom-out",
      "canvas-fit",
      "palette-search",
    ]);
  });

  it("lists the two readouts", () => {
    expect(Object.values(readoutTestIds)).toEqual(["canvas-flow", "canvas-selection"]);
  });
});
