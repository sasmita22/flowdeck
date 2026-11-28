import type { FlowContainer, NodeType } from "../../core/flow/schema.js";

export const paletteTestId = (type: NodeType | FlowContainer["kind"] | "note") =>
  `palette-${type}` as const;

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
  blueprintSettings: "blueprint-settings",
} as const;

export const blueprintVariableTestIds = {
  list: "blueprint-variables",
  variable: (name: string) => `blueprint-variable-${name}`,
} as const;

export type ContainerField = "name" | "model" | "repo" | "branch";

export type FrameGripSide = "top" | "left" | "right" | "bottom";

export const containerTestIds = {
  frame: (id: string) => `container-frame-${id}`,
  frameGrip: (id: string, side: FrameGripSide) => `container-frame-${id}-grip-${side}`,
  field: (id: string, field: ContainerField) => `container-${id}-${field}`,
  frameSource: (id: string) => `container-frame-${id}-source`,
  frameTarget: (id: string) => `container-frame-${id}-target`,
  frameFlowIn: (id: string) => `container-frame-${id}-flow-in`,
  frameFlowOut: (id: string) => `container-frame-${id}-flow-out`,
  connection: (id: string) => `connection-${id}`,
} as const;

export type LibraryOverrideField = "repo" | "branch" | "model";

export const libraryTestIds = {
  paletteItem: (flowId: string) => `palette-lib-${flowId}`,
  name: (nodeId: string) => `library-name-${nodeId}`,
  label: "library-label",
  override: (sessionId: string, field: LibraryOverrideField) =>
    `library-override-${sessionId}-${field}`,
} as const;

export const blueprintTerminalTestId = "blueprint-terminal";

export const readoutTestIds = {
  flow: "canvas-flow",
  selection: "canvas-selection",
  wires: "canvas-selected-wires",
} as const;

const stageKey = (runId: string, nodeId: string, round?: number) =>
  round === undefined ? `${runId}-${nodeId}` : `${runId}-${nodeId}-${round}`;

export type UsedByScope = "settings" | "card" | "delete";

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
  blueprintDeleteInUse: "blueprint-delete-in-use",
  usedByList: (scope: UsedByScope, libraryId: string) => `used-by-${scope}-${libraryId}`,
  usedByNone: (scope: UsedByScope, libraryId: string) => `used-by-none-${scope}-${libraryId}`,
  usedByOpen: (scope: UsedByScope, libraryId: string, flowId: string) =>
    `used-by-open-${scope}-${libraryId}-${flowId}`,
  blueprintNameInput: (flowId: string) => `blueprint-name-input-${flowId}`,
  blueprintBuild: (flowId: string) => `blueprint-build-${flowId}`,
  blueprintKind: (flowId: string) => `blueprint-kind-${flowId}`,
  blueprintBuildReason: (flowId: string) => `blueprint-build-reason-${flowId}`,
  buildDisabledReason: "build-disabled-reason",
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
  buildWorktreeLine: (pendingId: string, path: string) => `build-worktree-${pendingId}-${path}`,
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
  runStory: "run-story",
  runPageMenu: "run-page-menu",
  runPageDelete: "run-page-delete",
  runBuildTag: "run-build-tag",
  runStoryWrite: "run-story-write",
  runStoryWriteError: "run-story-write-error",
  runStoryHeader: "run-story-header",
  runStoryOtherRepos: "run-story-other-repos",
  runStoryAccount: "run-story-account",
  runStoryContext: "story-context",
  runStoryGoal: "story-goal",
  runStoryResult: "story-result",
  runStoryDigest: "run-story-digest",
  runStoryDigestToggle: "run-story-digest-toggle",
  runRowStoryLine: "run-row-story-line",
  runPageStatus: "run-page-status",
  runPageNote: "run-page-note",
  runStop: "run-stop",
  runResume: "run-resume",
  runContainerGroup: (name: string) => `run-container-group-${name}`,
  runContainerStatus: (name: string) => `run-container-status-${name}`,
  runSessionFailure: "run-session-failure",
  terminalSessionPicker: "terminal-session-picker",
  terminalSessionOption: (name: string) => `terminal-session-option-${name}`,
  doctorScopeBanner: "doctor-scope-banner",
  doctorRecheck: "doctor-recheck",
  doctorInstalled: (name: string) => `doctor-installed-${name}`,
  doctorWorktrees: "doctor-worktrees",
  leaveSave: "leave-save",
  leaveDiscard: "leave-discard",
  leaveCancel: "leave-cancel",
  saveWarningDialog: "save-warning-dialog",
  saveWarningText: "save-warning-text",
  saveWarningSave: "save-warning-save",
  saveWarningCancel: "save-warning-cancel",
  stopAgentDialog: "stop-agent-dialog",
  stopAgentConfirm: "stop-agent-confirm",
  stopAgentCancel: "stop-agent-cancel",
  runQuitDialog: "run-quit-dialog",
  runQuitOverlay: "run-quit-overlay",
  runQuitKeep: "run-quit-keep",
  runQuitStop: "run-quit-stop",
  runQuitCancel: "run-quit-cancel",
  deletePrompt: "delete-prompt",
  deletePromptConfirm: "delete-prompt-confirm",
  deletePromptCancel: "delete-prompt-cancel",
  deletePromptWarning: "delete-prompt-warning",
  deletePromptWorktrees: "delete-prompt-worktrees",
  deletePromptWorktree: (path: string) => `delete-prompt-worktree-${path}`,
} as const;

export const dialogTestIds = {
  dialog: "run-dialog",
  auto: "run-dialog-auto",
  start: "run-dialog-start",
  cancel: "run-dialog-cancel",
  variable: (name: string) => `run-dialog-variable-${name}`,
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
  sessions: "build-dialog-sessions",
  session: (name: string) => `build-dialog-session-${name}`,
  sessionRepo: (name: string) => `build-dialog-session-repo-${name}`,
  sessionBranch: (name: string) => `build-dialog-session-branch-${name}`,
  variable: (name: string) => `build-dialog-variable-${name}`,
  group: (path: string) => `build-dialog-group-${path}`,
  refusal: "build-dialog-refusal",
  confirm: "build-dialog-confirm",
  cancel: "build-dialog-cancel",
  error: "build-dialog-error",
  ignored: "build-dialog-ignored",
  ignoredNode: (id: string) => `build-dialog-ignored-${id}`,
  buildAnyway: "build-dialog-build-anyway",
  ignoredCancel: "build-dialog-ignored-cancel",
} as const;

export const branchVariableTestId = "node-setting-variable";

export const branchVariableExistingTestId = "node-setting-variable-existing";

export const agentProducesTestId = "node-setting-produces";

export const agentProducesAddTestId = "node-setting-produces-add";

export const produceRowTestIds = {
  variable: (index: number) => `node-setting-produces-${index}-variable`,
  yesIf: (index: number) => `node-setting-produces-${index}-yes-if`,
  noIf: (index: number) => `node-setting-produces-${index}-no-if`,
  remove: (index: number) => `node-setting-produces-${index}-remove`,
} as const;
