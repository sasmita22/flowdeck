import type { NodeType } from "../../core/flow/schema.js";

export const paletteTestId = (type: NodeType | "note") => `palette-${type}` as const;

export const controlTestIds = {
  save: "canvas-save",
  build: "canvas-build",
  built: "editor-built",
  back: "nav-back",
  title: "flow-title",
  more: "menu-more",
  sessionSettings: "session-settings-open",
  terminalOpen: "terminal-open",
  terminalClose: "menu-terminal-close",
  sidebarHide: "sidebar-hide",
  sidebarShow: "sidebar-show",
  inspectorHide: "inspector-hide",
  inspectorShow: "inspector-show",
  sidebarResize: "sidebar-resize",
  inspectorResize: "inspector-resize",
  undo: "canvas-undo",
  redo: "canvas-redo",
  delete: "canvas-delete",
  sessionChip: "session-chip",
  zoomIn: "canvas-zoom-in",
  zoomOut: "canvas-zoom-out",
  fit: "canvas-fit",
  search: "palette-search",
} as const;

export const readoutTestIds = {
  flow: "canvas-flow",
  selection: "canvas-selection",
  wires: "canvas-selected-wires",
} as const;

export const pageTestIds = {
  newBlueprint: "menu-new",
  search: "menu-search",
  recent: (flowId: string) => `menu-recent-${flowId}`,
  title: "page-title",
  query: "page-search",
  sort: "page-sort",
  create: "blueprint-new",
  blueprintCard: (flowId: string) => `blueprint-card-${flowId}`,
  blueprintOpen: (flowId: string) => `blueprint-open-${flowId}`,
  blueprintRename: (flowId: string) => `blueprint-rename-${flowId}`,
  blueprintNameInput: (flowId: string) => `blueprint-name-input-${flowId}`,
  blueprintBuild: (flowId: string) => `blueprint-build-${flowId}`,
  buildCard: (buildId: string) => `build-card-${buildId}`,
  buildOpen: (buildId: string) => `build-open-${buildId}`,
  buildRun: (buildId: string) => `build-run-${buildId}`,
  buildResume: (buildId: string) => `build-resume-${buildId}`,
  buildStop: (buildId: string) => `build-stop-${buildId}`,
  buildDelete: (buildId: string) => `build-delete-${buildId}`,
  buildOld: (buildId: string) => `build-old-${buildId}`,
  buildKept: (buildId: string) => `build-kept-${buildId}`,
  buildFile: (path: string) => `build-file-${path}`,
  buildFileContent: "build-file-content",
  buildBack: "build-back",
  buildDetailRun: "build-detail-run",
  runCard: (runId: string) => `run-card-${runId}`,
  runOpen: (runId: string) => `run-open-${runId}`,
  runResult: (runId: string) => `run-result-${runId}`,
  runBack: "run-back",
  runAgain: "run-again",
  runOpenBlueprint: "run-open-blueprint",
  runPageStatus: "run-page-status",
  runPageNote: "run-page-note",
  runStop: "run-stop",
  runResume: "run-resume",
  doctorBlueprint: "doctor-blueprint",
  doctorRecheck: "doctor-recheck",
  doctorNeeded: (name: string) => `doctor-needed-${name}`,
  doctorFix: (name: string) => `doctor-fix-${name}`,
  doctorInstalled: (name: string) => `doctor-installed-${name}`,
  doctorWorktrees: "doctor-worktrees",
  leaveSave: "leave-save",
  leaveDiscard: "leave-discard",
  leaveCancel: "leave-cancel",
} as const;

export const dialogTestIds = {
  dialog: "run-dialog",
  auto: "run-dialog-auto",
  start: "run-dialog-start",
  cancel: "run-dialog-cancel",
} as const;

export const buildDialogTestIds = {
  dialog: "build-dialog",
  name: "build-dialog-name",
  repo: "build-dialog-repo",
  base: "build-dialog-base",
  variable: (name: string) => `build-dialog-variable-${name}`,
  confirm: "build-dialog-confirm",
  cancel: "build-dialog-cancel",
  error: "build-dialog-error",
} as const;

export const buildConfigTestIds = {
  repo: "session-build-config-repo",
  base: "session-build-config-base",
  addVariable: "build-config-add-variable",
  variable: (name: string) => `build-config-variable-${name}`,
  variableName: (index: number) => `build-config-variable-name-${index}`,
  variableKind: (index: number) => `build-config-variable-kind-${index}`,
  variableDefault: (index: number) => `build-config-variable-default-${index}`,
  variableRemove: (index: number) => `build-config-variable-remove-${index}`,
} as const;

export const branchVariableTestId = "node-setting-variable";
