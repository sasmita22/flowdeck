import { createStore, type StoreApi } from "zustand/vanilla";
import type { CanvasState } from "./canvas/store.js";
import type { RunState } from "./run-store.js";
import { controlTestIds } from "./test-ids.js";

type RunView = Pick<RunState, "snapshot">;

type SelectionView = Pick<CanvasState, "selection" | "select">;

export type Panel = "sidebar" | "inspector";

export type PanelWidths = Record<Panel, number>;

export type WidthStorage = Pick<Storage, "getItem" | "setItem">;

export const panelWidthKey = "flowdeck.panelWidths";

export const panelWidthLimits = {
  sidebar: { initial: 260, min: 200, max: 480 },
  inspector: { initial: 260, min: 240, max: 560 },
} as const satisfies Record<Panel, { initial: number; min: number; max: number }>;

export const CANVAS_MIN = 320;

export const inspectorFrame = 25;

const panels = Object.keys(panelWidthLimits) as Panel[];

const clampWidth = (panel: Panel, width: number) => {
  const { min, max } = panelWidthLimits[panel];
  return Math.min(max, Math.max(min, Math.round(width)));
};

const initialWidths = (): PanelWidths => ({
  sidebar: panelWidthLimits.sidebar.initial,
  inspector: panelWidthLimits.inspector.initial,
});

const loadWidths = (storage: WidthStorage | undefined): PanelWidths => {
  const widths = initialWidths();
  let saved: unknown;
  try {
    saved = JSON.parse(storage?.getItem(panelWidthKey) ?? "null");
  } catch {
    return widths;
  }
  if (typeof saved !== "object" || saved === null) return widths;
  for (const panel of panels) {
    const width = (saved as Partial<Record<Panel, unknown>>)[panel];
    if (typeof width === "number" && Number.isFinite(width))
      widths[panel] = clampWidth(panel, width);
  }
  return widths;
};

const saveWidths = (storage: WidthStorage | undefined, widths: PanelWidths) => {
  try {
    storage?.setItem(panelWidthKey, JSON.stringify(widths));
  } catch {
    return;
  }
};

export type ShellState = {
  sidebarOpen: boolean;
  menuOpen: boolean;
  inspectorShown: boolean | null;
  panelFocus: string | null;
  sessionSettingsOpen: boolean;
  panelWidths: PanelWidths;
  windowWidth: number;
  setWindowWidth(width: number): void;
  resizePanel(panel: Panel, width: number): void;
  resetPanelWidth(panel: Panel): void;
  toggleSidebar(): void;
  toggleInspector(run: RunView): void;
  showInspector(): void;
  clearPanelFocus(): void;
  openMenu(): void;
  closeMenu(): void;
  toggleSessionSettings(): void;
  closeSessionSettings(): void;
};

export const selectInspectorOpen = (
  shell: Pick<ShellState, "inspectorShown">,
  run: RunView,
): boolean => shell.inspectorShown ?? run.snapshot !== null;

const fit = (panel: Panel, preferred: number, room: number) =>
  Math.max(panelWidthLimits[panel].min, Math.min(preferred, room));

export const selectShownWidths = (
  shell: Pick<ShellState, "panelWidths" | "windowWidth" | "sidebarOpen">,
  inspectorOpen: boolean,
): PanelWidths => {
  const room = shell.windowWidth - CANVAS_MIN - (inspectorOpen ? inspectorFrame : 0);
  const inspector = inspectorOpen
    ? fit(
        "inspector",
        shell.panelWidths.inspector,
        room - (shell.sidebarOpen ? panelWidthLimits.sidebar.min : 0),
      )
    : 0;
  const sidebar = shell.sidebarOpen
    ? fit("sidebar", shell.panelWidths.sidebar, room - inspector)
    : 0;
  return { sidebar, inspector };
};

export const createShellStore = ({
  canvas,
  storage,
}: {
  canvas: StoreApi<SelectionView>;
  storage?: WidthStorage | undefined;
}): StoreApi<ShellState> => {
  const setWidth = (panel: Panel, width: number) => {
    const panelWidths = { ...store.getState().panelWidths, [panel]: clampWidth(panel, width) };
    store.setState({ panelWidths });
    saveWidths(storage, panelWidths);
  };

  const store = createStore<ShellState>()((set, get) => ({
    sidebarOpen: true,
    menuOpen: false,
    inspectorShown: null,
    panelFocus: null,
    sessionSettingsOpen: false,
    panelWidths: loadWidths(storage),
    windowWidth: Number.POSITIVE_INFINITY,
    setWindowWidth: (windowWidth) => set({ windowWidth }),
    resizePanel: (panel, width) => setWidth(panel, width),
    resetPanelWidth: (panel) => setWidth(panel, panelWidthLimits[panel].initial),
    toggleSidebar: () => {
      const sidebarOpen = !get().sidebarOpen;
      set({
        sidebarOpen,
        panelFocus: sidebarOpen ? controlTestIds.sidebarHide : controlTestIds.sidebarShow,
      });
    },
    toggleInspector: (run) => {
      const inspectorShown = !selectInspectorOpen(get(), run);
      set({
        inspectorShown,
        panelFocus: inspectorShown ? controlTestIds.inspectorHide : controlTestIds.inspectorShow,
      });
    },
    showInspector: () => set({ inspectorShown: true }),
    clearPanelFocus: () => set({ panelFocus: null }),
    openMenu: () => set({ menuOpen: true }),
    closeMenu: () => set({ menuOpen: false }),
    toggleSessionSettings: () => {
      if (get().sessionSettingsOpen) {
        set({ sessionSettingsOpen: false });
        return;
      }
      canvas.getState().select([]);
      set({ sessionSettingsOpen: true, inspectorShown: true });
    },
    closeSessionSettings: () => set({ sessionSettingsOpen: false }),
  }));

  canvas.subscribe((next) => {
    if (next.selection.length > 0 && store.getState().sessionSettingsOpen) {
      store.getState().closeSessionSettings();
    }
  });

  return store;
};

export const emptyCanvasHint = (empty: boolean, sidebarOpen: boolean): string | null => {
  if (!empty) return null;
  return sidebarOpen
    ? "Pick a node from the left to start"
    : "Show the node sidebar with the button at the top left to start";
};

export type MenuAction = "terminal-open" | "terminal-close";

export type MenuItem = { action: MenuAction; testId: string; label: string; disabled: boolean };

export const menuItems = (state: {
  terminalOpen: boolean;
  terminalAvailable: boolean;
}): MenuItem[] => [
  state.terminalOpen
    ? {
        action: "terminal-close",
        testId: controlTestIds.terminalClose,
        label: "Close terminal",
        disabled: false,
      }
    : {
        action: "terminal-open",
        testId: controlTestIds.terminalOpen,
        label: "Open terminal",
        disabled: !state.terminalAvailable,
      },
];

export const nextMenuIndex = (current: number, key: string, count: number): number => {
  switch (key) {
    case "ArrowDown":
      return (current + 1) % count;
    case "ArrowUp":
      return (current - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return current;
  }
};
