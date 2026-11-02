import { createStore, type StoreApi } from "zustand/vanilla";
import type { RunState } from "./run-store.js";
import { controlTestIds } from "./test-ids.js";

type RunView = Pick<RunState, "snapshot">;

export type ShellState = {
  sidebarOpen: boolean;
  menuOpen: boolean;
  inspectorShown: boolean | null;
  toggleSidebar(): void;
  toggleInspector(run: RunView): void;
  openMenu(): void;
  closeMenu(): void;
};

export const selectInspectorOpen = (
  shell: Pick<ShellState, "inspectorShown">,
  run: RunView,
): boolean => shell.inspectorShown ?? run.snapshot !== null;

export const createShellStore = (): StoreApi<ShellState> =>
  createStore<ShellState>()((set, get) => ({
    sidebarOpen: true,
    menuOpen: false,
    inspectorShown: null,
    toggleSidebar: () => set({ sidebarOpen: !get().sidebarOpen }),
    toggleInspector: (run) => set({ inspectorShown: !selectInspectorOpen(get(), run) }),
    openMenu: () => set({ menuOpen: true }),
    closeMenu: () => set({ menuOpen: false }),
  }));

export const emptyCanvasHint = (empty: boolean, sidebarOpen: boolean): string | null => {
  if (!empty) return null;
  return sidebarOpen
    ? "Pick a node from the left to start"
    : "Show the node sidebar from the ⋯ menu to start";
};

export type MenuAction = "terminal-open" | "terminal-close" | "sidebar" | "inspector";

export type MenuItem = { action: MenuAction; testId: string; label: string; disabled: boolean };

export const menuItems = (state: {
  terminalOpen: boolean;
  terminalAvailable: boolean;
  sidebarOpen: boolean;
  inspectorOpen: boolean;
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
  {
    action: "sidebar",
    testId: controlTestIds.sidebar,
    label: state.sidebarOpen ? "Hide node sidebar" : "Show node sidebar",
    disabled: false,
  },
  {
    action: "inspector",
    testId: controlTestIds.inspector,
    label: state.inspectorOpen ? "Hide inspector" : "Show inspector",
    disabled: false,
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
