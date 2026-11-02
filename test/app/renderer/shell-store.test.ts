import { describe, expect, it } from "vitest";
import {
  createShellStore,
  emptyCanvasHint,
  menuItems,
  nextMenuIndex,
  selectInspectorOpen,
} from "../../../src/app/renderer/shell-store.js";

const noRun = { snapshot: null };
const aRun = { snapshot: { runId: "run-1", status: "running" as const, nodes: {} } };

describe("createShellStore", () => {
  it("starts with the sidebar shown, the menu closed and the inspector following the run", () => {
    expect(createShellStore().getState()).toMatchObject({
      sidebarOpen: true,
      menuOpen: false,
      inspectorShown: null,
    });
  });

  it("toggles the sidebar", () => {
    const shell = createShellStore();

    shell.getState().toggleSidebar();
    expect(shell.getState().sidebarOpen).toBe(false);

    shell.getState().toggleSidebar();
    expect(shell.getState().sidebarOpen).toBe(true);
  });

  it("opens and closes the menu", () => {
    const shell = createShellStore();

    shell.getState().openMenu();
    expect(shell.getState().menuOpen).toBe(true);

    shell.getState().closeMenu();
    expect(shell.getState().menuOpen).toBe(false);
  });
});

describe("selectInspectorOpen", () => {
  it("is closed with no run and open with one", () => {
    const shell = createShellStore().getState();

    expect(selectInspectorOpen(shell, noRun)).toBe(false);
    expect(selectInspectorOpen(shell, aRun)).toBe(true);
  });

  it.each([
    ["no run", noRun, true],
    ["a run", aRun, false],
  ])("flips what it was with %s after a toggle", (_name, run, expected) => {
    const shell = createShellStore();

    shell.getState().toggleInspector(run);

    expect(selectInspectorOpen(shell.getState(), run)).toBe(expected);
    expect(selectInspectorOpen(shell.getState(), run === noRun ? aRun : noRun)).toBe(expected);
  });

  it("flips back on a second toggle", () => {
    const shell = createShellStore();

    shell.getState().toggleInspector(aRun);
    shell.getState().toggleInspector(aRun);

    expect(selectInspectorOpen(shell.getState(), aRun)).toBe(true);
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

  it("points at the menu when the sidebar is hidden", () => {
    expect(emptyCanvasHint(true, false)).toBe("Show the node sidebar from the ⋯ menu to start");
  });
});

describe("menuItems", () => {
  const view = (state: Parameters<typeof menuItems>[0]) =>
    menuItems(state).map(({ testId, label, disabled }) => ({ testId, label, disabled }));

  it("offers Open terminal, disabled with no session, then Hide for the shown panels", () => {
    expect(
      view({
        terminalOpen: false,
        terminalAvailable: false,
        sidebarOpen: true,
        inspectorOpen: true,
      }),
    ).toEqual([
      { testId: "terminal-open", label: "Open terminal", disabled: true },
      { testId: "menu-sidebar", label: "Hide node sidebar", disabled: false },
      { testId: "menu-inspector", label: "Hide inspector", disabled: false },
    ]);
  });

  it("enables Open terminal with a session and offers Show for hidden panels", () => {
    expect(
      view({
        terminalOpen: false,
        terminalAvailable: true,
        sidebarOpen: false,
        inspectorOpen: false,
      }),
    ).toEqual([
      { testId: "terminal-open", label: "Open terminal", disabled: false },
      { testId: "menu-sidebar", label: "Show node sidebar", disabled: false },
      { testId: "menu-inspector", label: "Show inspector", disabled: false },
    ]);
  });

  it.each([true, false])("offers Close terminal while it is open (available %s)", (available) => {
    expect(
      view({
        terminalOpen: true,
        terminalAvailable: available,
        sidebarOpen: true,
        inspectorOpen: false,
      })[0],
    ).toEqual({ testId: "menu-terminal-close", label: "Close terminal", disabled: false });
  });
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
