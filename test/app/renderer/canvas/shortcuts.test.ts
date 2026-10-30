import { describe, expect, it } from "vitest";
import { shortcutFor } from "../../../../src/app/renderer/canvas/shortcuts.js";

describe("shortcutFor", () => {
  it("maps Cmd+Z to undo", () => {
    expect(shortcutFor({ key: "z", metaKey: true, shiftKey: false })).toBe("undo");
  });

  it.each(["z", "Z"])("maps Shift+Cmd+%s to redo", (key) => {
    expect(shortcutFor({ key, metaKey: true, shiftKey: true })).toBe("redo");
  });

  it("maps Z without Cmd to nothing", () => {
    expect(shortcutFor({ key: "z", metaKey: false, shiftKey: false })).toBeNull();
    expect(shortcutFor({ key: "Z", metaKey: false, shiftKey: true })).toBeNull();
  });

  it.each(["Delete", "Backspace", "y"])("maps Cmd+%s to nothing", (key) => {
    expect(shortcutFor({ key, metaKey: true, shiftKey: false })).toBeNull();
    expect(shortcutFor({ key, metaKey: true, shiftKey: true })).toBeNull();
  });

  it.each(["s", "S"])("maps Cmd+%s to save", (key) => {
    expect(shortcutFor({ key, metaKey: true, shiftKey: false })).toBe("save");
  });

  it("maps S without Cmd, and Shift+Cmd+S, to something other than save", () => {
    expect(shortcutFor({ key: "s", metaKey: false, shiftKey: false })).not.toBe("save");
    expect(shortcutFor({ key: "S", metaKey: false, shiftKey: true })).not.toBe("save");
    expect(shortcutFor({ key: "s", metaKey: true, shiftKey: true })).not.toBe("save");
    expect(shortcutFor({ key: "S", metaKey: true, shiftKey: true })).not.toBe("save");
  });

  it.each(["a", "A"])("maps Cmd+%s to select-all", (key) => {
    expect(shortcutFor({ key, metaKey: true, shiftKey: false })).toBe("selectAll");
  });

  it.each(["a", "A"])("maps Ctrl+%s to select-all", (key) => {
    expect(shortcutFor({ key, metaKey: false, ctrlKey: true, shiftKey: false })).toBe("selectAll");
  });

  it("maps A without Cmd or Ctrl to nothing", () => {
    expect(shortcutFor({ key: "a", metaKey: false, ctrlKey: false, shiftKey: false })).toBeNull();
  });

  it.each([
    ["the canvas", { tagName: "DIV", isContentEditable: false }],
    ["the page body", { tagName: "BODY", isContentEditable: false }],
  ])("maps Cmd+A to select-all when the target is %s", (_name, target) => {
    expect(shortcutFor({ key: "a", metaKey: true, shiftKey: false, target })).toBe("selectAll");
  });

  it.each([
    ["an input", { tagName: "INPUT", isContentEditable: false }],
    ["a textarea", { tagName: "TEXTAREA", isContentEditable: false }],
    ["a contenteditable element", { tagName: "DIV", isContentEditable: true }],
  ])("maps Cmd+A and Ctrl+A in %s to nothing, keeping text select-all", (_name, target) => {
    expect(shortcutFor({ key: "a", metaKey: true, shiftKey: false, target })).toBeNull();
    expect(
      shortcutFor({ key: "a", metaKey: false, ctrlKey: true, shiftKey: false, target }),
    ).toBeNull();
  });
});
