import { describe, expect, it } from "vitest";
import { createCanvasStore } from "../../../src/app/renderer/canvas/store.js";
import {
  createShellStore,
  emptyCanvasHint,
  menuItems,
  nextMenuIndex,
  selectInspectorOpen,
} from "../../../src/app/renderer/shell-store.js";
import { controlTestIds } from "../../../src/app/renderer/test-ids.js";
import { flow, gate, prompt } from "../../fixtures/flow-builders.js";

const noRun = { snapshot: null };
const aRun = { snapshot: { runId: "run-1", status: "running" as const, nodes: {} } };

const newShell = (canvas = createCanvasStore()) => createShellStore({ canvas });

const twoNodes = () => {
  const canvas = createCanvasStore();
  canvas.getState().load(flow([prompt("prompt-1"), gate("gate-1")], []));
  return canvas;
};

describe("createShellStore", () => {
  it("starts with the sidebar shown, the menu closed and the inspector following the run", () => {
    expect(newShell().getState()).toMatchObject({
      sidebarOpen: true,
      menuOpen: false,
      inspectorShown: null,
      panelFocus: null,
      sessionSettingsOpen: false,
    });
  });

  it("toggles the sidebar", () => {
    const shell = newShell();

    shell.getState().toggleSidebar();
    expect(shell.getState().sidebarOpen).toBe(false);

    shell.getState().toggleSidebar();
    expect(shell.getState().sidebarOpen).toBe(true);
  });

  it("asks for focus on the sidebar button that replaces the one pressed", () => {
    const shell = newShell();

    shell.getState().toggleSidebar();
    expect(shell.getState().panelFocus).toBe(controlTestIds.sidebarShow);

    shell.getState().toggleSidebar();
    expect(shell.getState().panelFocus).toBe(controlTestIds.sidebarHide);
  });

  it("asks for focus on the inspector button that replaces the one pressed", () => {
    const shell = newShell();

    shell.getState().toggleInspector(noRun);
    expect(shell.getState().panelFocus).toBe(controlTestIds.inspectorHide);

    shell.getState().toggleInspector(noRun);
    expect(shell.getState().panelFocus).toBe(controlTestIds.inspectorShow);
  });

  it("clears the focus request once taken", () => {
    const shell = newShell();

    shell.getState().toggleSidebar();
    shell.getState().clearPanelFocus();

    expect(shell.getState().panelFocus).toBeNull();
  });

  it("opens and closes the menu", () => {
    const shell = newShell();

    shell.getState().openMenu();
    expect(shell.getState().menuOpen).toBe(true);

    shell.getState().closeMenu();
    expect(shell.getState().menuOpen).toBe(false);
  });
});

describe("selectInspectorOpen", () => {
  it("is closed with no run and open with one", () => {
    const shell = newShell().getState();

    expect(selectInspectorOpen(shell, noRun)).toBe(false);
    expect(selectInspectorOpen(shell, aRun)).toBe(true);
  });

  it.each([
    ["no run", noRun, true],
    ["a run", aRun, false],
  ])("flips what it was with %s after a toggle", (_name, run, expected) => {
    const shell = newShell();

    shell.getState().toggleInspector(run);

    expect(selectInspectorOpen(shell.getState(), run)).toBe(expected);
    expect(selectInspectorOpen(shell.getState(), run === noRun ? aRun : noRun)).toBe(expected);
  });

  it("flips back on a second toggle", () => {
    const shell = newShell();

    shell.getState().toggleInspector(aRun);
    shell.getState().toggleInspector(aRun);

    expect(selectInspectorOpen(shell.getState(), aRun)).toBe(true);
  });
});

describe("showInspector", () => {
  it.each([
    ["no run", noRun],
    ["a run", aRun],
  ])("opens the inspector with %s and leaves focus alone", (_name, run) => {
    const shell = newShell();
    shell.getState().toggleInspector(aRun);
    shell.getState().clearPanelFocus();

    shell.getState().showInspector();

    expect(selectInspectorOpen(shell.getState(), run)).toBe(true);
    expect(shell.getState().panelFocus).toBeNull();
  });
});

describe("session settings", () => {
  it("opens and closes from the gear", () => {
    const shell = newShell();

    shell.getState().toggleSessionSettings();
    expect(shell.getState().sessionSettingsOpen).toBe(true);

    shell.getState().toggleSessionSettings();
    expect(shell.getState().sessionSettingsOpen).toBe(false);
  });

  it("closes when the empty canvas is clicked", () => {
    const shell = newShell();
    shell.getState().toggleSessionSettings();

    shell.getState().closeSessionSettings();

    expect(shell.getState().sessionSettingsOpen).toBe(false);
  });

  it("closes when a node is selected", () => {
    const canvas = twoNodes();
    const shell = newShell(canvas);
    shell.getState().toggleSessionSettings();

    canvas.getState().select(["gate-1"]);

    expect(shell.getState().sessionSettingsOpen).toBe(false);
  });

  it("stays open while the selection stays empty", () => {
    const canvas = twoNodes();
    const shell = newShell(canvas);
    shell.getState().toggleSessionSettings();

    canvas.getState().select([]);

    expect(shell.getState().sessionSettingsOpen).toBe(true);
  });

  it("clears the node selection when it opens", () => {
    const canvas = twoNodes();
    canvas.getState().select(["prompt-1", "gate-1"]);
    const shell = newShell(canvas);

    shell.getState().toggleSessionSettings();

    expect(canvas.getState().selection).toEqual([]);
    expect(shell.getState().sessionSettingsOpen).toBe(true);
  });

  it("shows a hidden inspector when it opens", () => {
    const shell = newShell();
    shell.getState().toggleInspector(aRun);

    shell.getState().toggleSessionSettings();

    expect(selectInspectorOpen(shell.getState(), aRun)).toBe(true);
    expect(selectInspectorOpen(shell.getState(), noRun)).toBe(true);
  });

  it("leaves the inspector open when it closes", () => {
    const shell = newShell();
    shell.getState().toggleSessionSettings();

    shell.getState().toggleSessionSettings();

    expect(selectInspectorOpen(shell.getState(), noRun)).toBe(true);
  });
});

describe("emptyCanvasHint", () => {
  it("is null when the canvas has nodes", () => {
    expect(emptyCanvasHint(false, true)).toBeNull();
    expect(emptyCanvasHint(false, false)).toBeNull();
  });

  it("points at the sidebar when it is shown", () => {
    expect(emptyCanvasHint(true, true)).toBe("Pick a node from the left to start");
  });

  it("points at the show button when the sidebar is hidden", () => {
    expect(emptyCanvasHint(true, false)).toBe(
      "Show the node sidebar with the button at the top left to start",
    );
  });
});

describe("menuItems", () => {
  const view = (state: Parameters<typeof menuItems>[0]) =>
    menuItems(state).map(({ testId, label, disabled }) => ({ testId, label, disabled }));

  it.each([
    [false, true],
    [true, false],
  ])("offers only Open terminal, disabled %s with available %s", (disabled, available) => {
    expect(view({ terminalOpen: false, terminalAvailable: available })).toEqual([
      { testId: "terminal-open", label: "Open terminal", disabled },
    ]);
  });

  it.each([true, false])(
    "offers only Close terminal while it is open (available %s)",
    (available) => {
      expect(view({ terminalOpen: true, terminalAvailable: available })).toEqual([
        { testId: "menu-terminal-close", label: "Close terminal", disabled: false },
      ]);
    },
  );
});

describe("nextMenuIndex", () => {
  it.each([
    [0, "ArrowDown", 1],
    [2, "ArrowDown", 0],
    [1, "ArrowUp", 0],
    [0, "ArrowUp", 2],
    [1, "Home", 0],
    [0, "End", 2],
    [1, "a", 1],
    [1, "Tab", 1],
  ])("moves from %i on %s to %i of three", (current, key, expected) => {
    expect(nextMenuIndex(current, key, 3)).toBe(expected);
  });
});
