import type { NodeType } from "../../core/flow/schema.js";

export const paletteTestId = (type: NodeType | "note") => `palette-${type}` as const;

export const controlTestIds = {
  save: "canvas-save",
  run: "canvas-run",
  more: "menu-more",
  terminalOpen: "terminal-open",
  terminalClose: "menu-terminal-close",
  sidebarHide: "sidebar-hide",
  sidebarShow: "sidebar-show",
  inspectorHide: "inspector-hide",
  inspectorShow: "inspector-show",
  undo: "canvas-undo",
  redo: "canvas-redo",
  delete: "canvas-delete",
  wrap: "canvas-wrap",
  zoomIn: "canvas-zoom-in",
  zoomOut: "canvas-zoom-out",
  fit: "canvas-fit",
  search: "palette-search",
} as const;

export const readoutTestIds = {
  flow: "canvas-flow",
  selection: "canvas-selection",
} as const;
