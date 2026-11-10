import { describe, expect, it } from "vitest";
import { claimsShortcut, shortcutFor } from "../../../../src/app/renderer/canvas/shortcuts.js";
import { agent, flow } from "../../../fixtures/flow-builders.js";

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
    ["a select", { tagName: "SELECT", isContentEditable: false }],
    ["a contenteditable element", { tagName: "DIV", isContentEditable: true }],
  ])("maps Cmd+A and Ctrl+A in %s to nothing, keeping text select-all", (_name, target) => {
    expect(shortcutFor({ key: "a", metaKey: true, shiftKey: false, target })).toBeNull();
    expect(
      shortcutFor({ key: "a", metaKey: false, ctrlKey: true, shiftKey: false, target }),
    ).toBeNull();
  });

  it.each([
    ["an input", { tagName: "INPUT", isContentEditable: false }],
    ["a textarea", { tagName: "TEXTAREA", isContentEditable: false }],
    ["a select", { tagName: "SELECT", isContentEditable: false }],
    ["a contenteditable element", { tagName: "DIV", isContentEditable: true }],
  ])("leaves Cmd+Z and Shift+Cmd+Z in %s to the field", (_name, target) => {
    expect(shortcutFor({ key: "z", metaKey: true, shiftKey: false, target })).toBeNull();
    expect(shortcutFor({ key: "z", metaKey: true, shiftKey: true, target })).toBeNull();
  });

  it.each([
    ["the canvas", { tagName: "DIV", isContentEditable: false }],
    ["the page body", { tagName: "BODY", isContentEditable: false }],
  ])("maps Cmd+Z and Shift+Cmd+Z on %s to undo and redo", (_name, target) => {
    expect(shortcutFor({ key: "z", metaKey: true, shiftKey: false, target })).toBe("undo");
    expect(shortcutFor({ key: "z", metaKey: true, shiftKey: true, target })).toBe("redo");
  });

  it.each([
    ["c", "copy"],
    ["v", "paste"],
    ["d", "duplicate"],
    ["=", "zoomIn"],
    ["+", "zoomIn"],
    ["-", "zoomOut"],
    ["0", "zoomReset"],
  ] as const)("maps Cmd+%s to %s on the canvas", (key, shortcut) => {
    expect(shortcutFor({ key, metaKey: true, shiftKey: false, target: canvas })).toBe(shortcut);
  });

  it("maps Enter on the canvas, with no modifier, to rename", () => {
    expect(shortcutFor({ key: "Enter", metaKey: false, shiftKey: false, target: canvas })).toBe(
      "rename",
    );
    expect(
      shortcutFor({ key: "Enter", metaKey: true, shiftKey: false, target: canvas }),
    ).toBeNull();
  });

  it.each([
    ["an input", { tagName: "INPUT", isContentEditable: false }],
    ["a textarea", { tagName: "TEXTAREA", isContentEditable: false }],
    ["a contenteditable element", { tagName: "DIV", isContentEditable: true }],
  ])("leaves copy, paste, duplicate, zoom and Enter in %s to the field", (_name, target) => {
    for (const key of ["c", "v", "d", "=", "-", "0"]) {
      expect(shortcutFor({ key, metaKey: true, shiftKey: false, target }), key).toBeNull();
    }
    expect(shortcutFor({ key: "Enter", metaKey: false, shiftKey: false, target })).toBeNull();
  });

  it("leaves Enter on a focused button to the button", () => {
    const button = { tagName: "BUTTON", isContentEditable: false };

    expect(
      shortcutFor({ key: "Enter", metaKey: false, shiftKey: false, target: button }),
    ).toBeNull();
  });

  it("maps C, V and D without Cmd to nothing", () => {
    for (const key of ["c", "v", "d"]) {
      expect(shortcutFor({ key, metaKey: false, shiftKey: false, target: canvas })).toBeNull();
    }
  });
});

const canvas = { tagName: "DIV", isContentEditable: false };

describe("claimsShortcut", () => {
  const withNote = {
    ...flow([agent("A")], []),
    notes: [{ id: "n1", text: "", position: { x: 0, y: 0 }, size: { width: 160, height: 90 } }],
  };
  const state = (selection: string[], clipboard: object | null = null, ready = true) => ({
    flow: withNote,
    selection,
    clipboard,
    ready,
  });

  it.each(["copy", "duplicate"] as const)(
    "leaves %s to the page when no node or note is selected, so selected text still copies",
    (shortcut) => {
      expect(claimsShortcut(shortcut, state([]))).toBe(false);
      expect(claimsShortcut(shortcut, state(["gone"]))).toBe(false);
    },
  );

  it.each(["copy", "duplicate"] as const)("claims %s for a selected node or note", (shortcut) => {
    expect(claimsShortcut(shortcut, state(["A"]))).toBe(true);
    expect(claimsShortcut(shortcut, state(["n1"]))).toBe(true);
  });

  it("claims Cmd+V only when something was copied", () => {
    expect(claimsShortcut("paste", state([]))).toBe(false);
    expect(claimsShortcut("paste", state([], { nodes: [], wires: [], notes: [] }))).toBe(true);
  });

  it("leaves copy, paste and duplicate to the page while the canvas is not ready", () => {
    for (const shortcut of ["copy", "paste", "duplicate"] as const) {
      expect(claimsShortcut(shortcut, state(["A"], {}, false))).toBe(false);
    }
  });

  it.each(["undo", "save", "zoomIn"] as const)(
    "claims %s regardless of the selection",
    (shortcut) => {
      expect(claimsShortcut(shortcut, state([]))).toBe(true);
    },
  );
});
