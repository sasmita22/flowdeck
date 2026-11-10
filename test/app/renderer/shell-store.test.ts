import { describe, expect, it } from "vitest";
import { createCanvasStore } from "../../../src/app/renderer/canvas/store.js";
import {
  CANVAS_MIN,
  createShellStore,
  inspectorFrame,
  emptyCanvasHint,
  menuItems,
  nextMenuIndex,
  panelWidthKey,
  panelWidthLimits,
  selectInspectorOpen,
  selectShownWidths,
  type WidthStorage,
} from "../../../src/app/renderer/shell-store.js";
import { controlTestIds } from "../../../src/app/renderer/test-ids.js";
import { agent, flow, gate } from "../../fixtures/flow-builders.js";

const noRun = { snapshot: null };
const aRun = { snapshot: { runId: "run-1", status: "running" as const, nodes: {} } };

const newShell = (canvas = createCanvasStore()) => createShellStore({ canvas });

const twoNodes = () => {
  const canvas = createCanvasStore();
  canvas.getState().load(flow([agent("agent-1"), gate("gate-1")], []));
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

  it("opens on request and stays open when asked again, clearing the node selection", () => {
    const canvas = twoNodes();
    canvas.getState().select(["gate-1"]);
    const shell = newShell(canvas);

    shell.getState().openSessionSettings();
    shell.getState().openSessionSettings();

    expect(shell.getState().sessionSettingsOpen).toBe(true);
    expect(canvas.getState().selection).toEqual([]);
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
    canvas.getState().select(["agent-1", "gate-1"]);
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

const memoryStorage = (saved?: string): WidthStorage & { saved: string | null } => {
  const storage = {
    saved: saved ?? null,
    getItem: (key: string) => (key === panelWidthKey ? storage.saved : null),
    setItem: (key: string, value: string) => {
      if (key === panelWidthKey) storage.saved = value;
    },
  };
  return storage;
};

const brokenStorage: WidthStorage = {
  getItem: () => {
    throw new Error("storage is off");
  },
  setItem: () => {
    throw new Error("storage is off");
  },
};

describe("panel widths", () => {
  const withStorage = (storage: WidthStorage) =>
    createShellStore({ canvas: createCanvasStore(), storage });

  it("starts both panels at their default width", () => {
    expect(newShell().getState().panelWidths).toEqual({ sidebar: 260, inspector: 260 });
  });

  it.each(["sidebar", "inspector"] as const)("resizes the %s within its limits", (panel) => {
    const shell = newShell();
    const { min, max } = panelWidthLimits[panel];

    shell.getState().resizePanel(panel, 300);
    expect(shell.getState().panelWidths[panel]).toBe(300);

    shell.getState().resizePanel(panel, min - 1);
    expect(shell.getState().panelWidths[panel]).toBe(min);

    shell.getState().resizePanel(panel, max + 1);
    expect(shell.getState().panelWidths[panel]).toBe(max);
  });

  it("uses the limits 200 to 480 for the sidebar and 240 to 560 for the inspector", () => {
    expect(panelWidthLimits).toEqual({
      sidebar: { initial: 260, min: 200, max: 480 },
      inspector: { initial: 260, min: 240, max: 560 },
    });
  });

  it("rounds a dragged width to whole pixels", () => {
    const shell = newShell();

    shell.getState().resizePanel("sidebar", 300.6);

    expect(shell.getState().panelWidths.sidebar).toBe(301);
  });

  it.each(["sidebar", "inspector"] as const)("resets the %s to its default", (panel) => {
    const shell = newShell();
    shell.getState().resizePanel(panel, 400);

    shell.getState().resetPanelWidth(panel);

    expect(shell.getState().panelWidths[panel]).toBe(panelWidthLimits[panel].initial);
  });

  it("leaves the other panel alone", () => {
    const shell = newShell();

    shell.getState().resizePanel("sidebar", 400);

    expect(shell.getState().panelWidths.inspector).toBe(260);
  });

  it("keeps the width while a panel is hidden and shown again", () => {
    const shell = newShell();
    shell.getState().resizePanel("sidebar", 400);
    shell.getState().resizePanel("inspector", 500);

    shell.getState().toggleSidebar();
    shell.getState().toggleSidebar();
    shell.getState().toggleInspector(noRun);
    shell.getState().toggleInspector(noRun);

    expect(shell.getState().panelWidths).toEqual({ sidebar: 400, inspector: 500 });
  });

  it("saves every resize and reset", () => {
    const storage = memoryStorage();
    const shell = withStorage(storage);

    shell.getState().resizePanel("sidebar", 400);
    expect(JSON.parse(storage.saved ?? "null")).toEqual({ sidebar: 400, inspector: 260 });

    shell.getState().resetPanelWidth("sidebar");
    expect(JSON.parse(storage.saved ?? "null")).toEqual({ sidebar: 260, inspector: 260 });
  });

  it("loads saved widths", () => {
    const shell = withStorage(memoryStorage(JSON.stringify({ sidebar: 400, inspector: 500 })));

    expect(shell.getState().panelWidths).toEqual({ sidebar: 400, inspector: 500 });
  });

  it("clamps a saved width outside the limits", () => {
    const shell = withStorage(memoryStorage(JSON.stringify({ sidebar: 9999, inspector: 1 })));

    expect(shell.getState().panelWidths).toEqual({ sidebar: 480, inspector: 240 });
  });

  it.each([
    ["text that is not JSON", "{"],
    ["JSON that is not an object", "42"],
    ["null", "null"],
    ["widths that are not numbers", JSON.stringify({ sidebar: "400", inspector: null })],
    ["missing widths", JSON.stringify({})],
  ])("falls back to the defaults for %s", (_name, saved) => {
    const shell = withStorage(memoryStorage(saved));

    expect(shell.getState().panelWidths).toEqual({ sidebar: 260, inspector: 260 });
  });

  it("keeps one good saved width when the other is bad", () => {
    const shell = withStorage(memoryStorage(JSON.stringify({ sidebar: 400, inspector: "x" })));

    expect(shell.getState().panelWidths).toEqual({ sidebar: 400, inspector: 260 });
  });

  it("still resizes when storage throws", () => {
    const shell = withStorage(brokenStorage);

    shell.getState().resizePanel("inspector", 400);

    expect(shell.getState().panelWidths.inspector).toBe(400);
  });
});

describe("panel widths that fit the window", () => {
  const atMax = () => {
    const storage = memoryStorage();
    const shell = createShellStore({ canvas: createCanvasStore(), storage });
    shell.getState().resizePanel("sidebar", panelWidthLimits.sidebar.max);
    shell.getState().resizePanel("inspector", panelWidthLimits.inspector.max);
    return { shell, storage };
  };
  const shown = (shell: ReturnType<typeof atMax>["shell"], inspectorOpen = true) =>
    selectShownWidths(shell.getState(), inspectorOpen);

  it("leaves the canvas about 320 pixels", () => {
    expect(CANVAS_MIN).toBe(320);
  });

  it("shows the preferred widths while the window is unknown", () => {
    expect(shown(atMax().shell)).toEqual({ sidebar: 480, inspector: 560 });
  });

  it("leaves the canvas its room at the smallest window with both panels at their maximum", () => {
    const { shell } = atMax();

    shell.getState().setWindowWidth(960);

    const { sidebar, inspector } = shown(shell);
    expect(960 - sidebar - inspector - inspectorFrame).toBeGreaterThanOrEqual(CANVAS_MIN);
    expect({ sidebar, inspector }).toEqual({ sidebar: 200, inspector: 415 });
  });

  it("narrows only the panel that no longer fits", () => {
    const shell = newShell();
    shell.getState().resizePanel("sidebar", panelWidthLimits.sidebar.max);

    shell.getState().setWindowWidth(960);

    expect(shown(shell)).toEqual({
      sidebar: 960 - CANVAS_MIN - inspectorFrame - 260,
      inspector: 260,
    });
  });

  it.each([
    ["sidebar", "sidebar", { sidebar: 0, inspector: 560 }],
    ["inspector", "inspector", { sidebar: 480, inspector: 0 }],
  ] as const)("gives a hidden %s's space to the other panel", (_name, hidden, expected) => {
    const { shell } = atMax();
    shell.getState().setWindowWidth(960);

    if (hidden === "sidebar") shell.getState().toggleSidebar();

    expect(shown(shell, hidden !== "inspector")).toEqual(expected);
  });

  it("brings the preferred widths back when the window grows again", () => {
    const { shell, storage } = atMax();
    const saved = storage.saved;

    shell.getState().setWindowWidth(960);
    shell.getState().setWindowWidth(1600);

    expect(shown(shell)).toEqual({ sidebar: 480, inspector: 560 });
    expect(shell.getState().panelWidths).toEqual({ sidebar: 480, inspector: 560 });
    expect(storage.saved).toBe(saved);
  });

  it.each([960, 700, 400, 0])("never shows a panel below its minimum at width %i", (width) => {
    const { shell } = atMax();

    shell.getState().setWindowWidth(width);

    const { sidebar, inspector } = shown(shell);
    expect(sidebar).toBeGreaterThanOrEqual(panelWidthLimits.sidebar.min);
    expect(inspector).toBeGreaterThanOrEqual(panelWidthLimits.inspector.min);
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

describe("run tab", () => {
  it("starts on Activity and shows the tab picked", () => {
    const shell = createShellStore({ canvas: createCanvasStore() });

    expect(shell.getState().runTab).toBe("activity");
    shell.getState().setRunTab("cost");
    expect(shell.getState().runTab).toBe("cost");
  });
});
