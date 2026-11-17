import type { NodeType } from "../../core/flow/schema.js";

export const paletteTestId = (type: NodeType | "note") => `palette-${type}` as const;

export const controlTestIds = {
  save: "canvas-save",
  build: "canvas-build",
  back: "nav-back",
  title: "flow-title",
  more: "menu-more",
  menuBuildsLive: "menu-builds-live",
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
  buildStop: "build-progress-stop",
  buildModel: "build-model",
  nodeMenuDuplicate: "node-menu-duplicate",
  nodeMenuFrameOnly: "node-menu-frame-only",
  blueprintTerminalToggle: "blueprint-terminal-toggle",
  blueprintTerminalMinimize: "blueprint-terminal-minimize",
  blueprintTerminalClose: "blueprint-terminal-close",
  tidy: "canvas-tidy",
} as const;

export const blueprintTerminalTestId = "blueprint-terminal";

export const readoutTestIds = {
  flow: "canvas-flow",
  selection: "canvas-selection",
  wires: "canvas-selected-wires",
} as const;

const stageKey = (runId: string, nodeId: string, round?: number) =>
  round === undefined ? `${runId}-${nodeId}` : `${runId}-${nodeId}-${round}`;

export const pageTestIds = {
  search: "menu-search",
  recent: (flowId: string) => `menu-recent-${flowId}`,
  recentPin: (flowId: string) => `recent-pin-${flowId}`,
  title: "page-title",
  query: "page-search",
  sort: "page-sort",
  create: "blueprint-new",
  blueprintCard: (flowId: string) => `blueprint-card-${flowId}`,
  blueprintOpen: (flowId: string) => `blueprint-open-${flowId}`,
  blueprintRename: (flowId: string) => `blueprint-rename-${flowId}`,
  blueprintPin: (flowId: string) => `blueprint-pin-${flowId}`,
  blueprintDelete: (flowId: string) => `blueprint-delete-${flowId}`,
  blueprintDeleteDialog: "blueprint-delete-dialog",
  blueprintDeleteConfirm: "blueprint-delete-confirm",
  blueprintDeleteCancel: "blueprint-delete-cancel",
  blueprintNameInput: (flowId: string) => `blueprint-name-input-${flowId}`,
  blueprintBuild: (flowId: string) => `blueprint-build-${flowId}`,
  buildCard: (buildId: string) => `build-card-${buildId}`,
  buildOpen: (buildId: string) => `build-open-${buildId}`,
  buildRun: (buildId: string) => `build-run-${buildId}`,
  buildResume: (buildId: string) => `build-resume-${buildId}`,
  buildStop: (buildId: string) => `build-stop-${buildId}`,
  buildMenu: (buildId: string) => `build-menu-${buildId}`,
  buildDelete: (buildId: string) => `build-delete-${buildId}`,
  buildingMenu: (pendingId: string) => `building-menu-${pendingId}`,
  buildingDelete: (pendingId: string) => `building-delete-${pendingId}`,
  runMenu: (runId: string) => `run-menu-${runId}`,
  runDelete: (runId: string) => `run-delete-${runId}`,
  buildOld: (buildId: string) => `build-old-${buildId}`,
  buildKept: (buildId: string) => `build-kept-${buildId}`,
  buildPictureToggle: (id: string) => `build-picture-toggle-${id}`,
  buildPictureImage: (id: string) => `build-picture-image-${id}`,
  buildPictureEmpty: (id: string) => `build-picture-empty-${id}`,
  buildFile: (path: string) => `build-file-${path}`,
  buildFileContent: "build-file-content",
  buildFolder: (path: string) => `build-folder-${path}`,
  buildProject: "build-project",
  buildProjectToggle: "build-project-toggle",
  buildProjectEntry: (path: string) => `build-project-entry-${path}`,
  pipelineTree: "pipeline-tree",
  buildBack: "build-back",
  buildDetailRun: "build-detail-run",
  buildingCard: (pendingId: string) => `building-card-${pendingId}`,
  buildProgress: (pendingId: string) => `build-progress-${pendingId}`,
  buildStage: (pendingId: string, step: number, round: number) =>
    `build-stage-${pendingId}-${step}-${round}`,
  buildRow: (pendingId: string, step: number, round: number, path: string) =>
    `build-row-${pendingId}-${step}-${round}-${path}`,
  buildBuiltLink: (pendingId: string) => `build-built-link-${pendingId}`,
  buildWorktree: (pendingId: string) => `build-worktree-${pendingId}`,
  buildElapsed: (pendingId: string) => `build-elapsed-${pendingId}`,
  buildQuestion: (pendingId: string, index: number) => `build-question-${pendingId}-${index}`,
  buildAnswer: (pendingId: string, index: number) => `build-answer-${pendingId}-${index}`,
  buildRebuild: (pendingId: string) => `build-rebuild-${pendingId}`,
  buildActivity: (pendingId: string) => `build-activity-${pendingId}`,
  buildLogTab: (pendingId: string) => `build-log-tab-${pendingId}`,
  buildTerminal: (pendingId: string) => `build-terminal-${pendingId}`,
  buildCost: (pendingId: string) => `build-cost-${pendingId}`,
  runsBuildFilter: "runs-build-filter",
  runCard: (runId: string) => `run-card-${runId}`,
  runCardStages: (runId: string) => `run-card-stages-${runId}`,
  buildRuns: "build-runs",
  runOpen: (runId: string) => `run-open-${runId}`,
  runResult: (runId: string) => `run-result-${runId}`,
  runBack: "run-back",
  runAgain: "run-again",
  runStage: (runId: string, nodeId: string, round?: number) =>
    `run-stage-${stageKey(runId, nodeId, round)}`,
  runStageStatus: (runId: string, nodeId: string, round?: number) =>
    `run-stage-status-${stageKey(runId, nodeId, round)}`,
  runStageDetail: (runId: string, nodeId: string, round?: number) =>
    `run-stage-detail-${stageKey(runId, nodeId, round)}`,
  runStageReason: (runId: string, nodeId: string, round?: number) =>
    `run-stage-reason-${stageKey(runId, nodeId, round)}`,
  runStageRetry: (runId: string, nodeId: string, round?: number) =>
    `run-stage-retry-${stageKey(runId, nodeId, round)}`,
  runStageReply: (runId: string, nodeId: string, round?: number) =>
    `run-stage-reply-${stageKey(runId, nodeId, round)}`,
  runRoundCost: (runId: string, containerId: string, round: number) =>
    `run-round-cost-${runId}-${containerId}-${round}`,
  runStagesNotRecorded: "run-stages-not-recorded",
  runStory: "run-story",
  runPageMenu: "run-page-menu",
  runPageDelete: "run-page-delete",
  runBuildTag: "run-build-tag",
  runStoryWrite: "run-story-write",
  runStoryWriteError: "run-story-write-error",
  runStoryHeader: "run-story-header",
  runStoryAccount: "run-story-account",
  runStoryDigest: "run-story-digest",
  runStoryDigestToggle: "run-story-digest-toggle",
  runRowStoryLine: "run-row-story-line",
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
  stopAgentDialog: "stop-agent-dialog",
  stopAgentConfirm: "stop-agent-confirm",
  stopAgentCancel: "stop-agent-cancel",
  deletePrompt: "delete-prompt",
  deletePromptConfirm: "delete-prompt-confirm",
  deletePromptCancel: "delete-prompt-cancel",
  deletePromptWarning: "delete-prompt-warning",
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
  repoBrowse: "build-dialog-repo-browse",
  baseInfo: "build-dialog-base-info",
  branchesError: "build-dialog-branches-error",
  branchNew: "build-dialog-branch-new",
  branchExisting: "build-dialog-branch-existing",
  branchName: "build-dialog-branch-name",
  existingBranch: (name: string) => `build-dialog-existing-branch-${name}`,
  variable: (name: string) => `build-dialog-variable-${name}`,
  confirm: "build-dialog-confirm",
  cancel: "build-dialog-cancel",
  error: "build-dialog-error",
  ignored: "build-dialog-ignored",
  ignoredNode: (id: string) => `build-dialog-ignored-${id}`,
  buildAnyway: "build-dialog-build-anyway",
  ignoredCancel: "build-dialog-ignored-cancel",
} as const;

export const buildConfigTestIds = {
  repo: "session-build-config-repo",
  base: "session-build-config-base",
  repoBrowse: "session-build-config-repo-browse",
  baseInfo: "session-build-config-base-info",
  branchesError: "session-branches-error",
  addVariable: "build-config-add-variable",
  variable: (name: string) => `build-config-variable-${name}`,
  variableName: (index: number) => `build-config-variable-name-${index}`,
  variableKind: (index: number) => `build-config-variable-kind-${index}`,
  variableDefault: (index: number) => `build-config-variable-default-${index}`,
  variableRemove: (index: number) => `build-config-variable-remove-${index}`,
} as const;

export const branchVariableTestId = "node-setting-variable";

export const branchDecidedByTestId = "node-setting-decided-by";

export const branchValueTestId = "node-setting-value";

export const agentProducesTestId = "node-setting-produces";
