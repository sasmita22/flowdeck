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

  it.each(["Delete", "Backspace", "y", "a"])("maps Cmd+%s to nothing", (key) => {
    expect(shortcutFor({ key, metaKey: true, shiftKey: false })).toBeNull();
    expect(shortcutFor({ key, metaKey: true, shiftKey: true })).toBeNull();
  });
});
