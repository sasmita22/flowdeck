import { describe, expect, it } from "vitest";
import {
  agentProducesTestId,
  branchDecidedByTestId,
  branchValueTestId,
  branchVariableTestId,
  buildConfigTestIds,
  buildDialogTestIds,
  controlTestIds,
  dialogTestIds,
  pageTestIds,
  paletteTestId,
  readoutTestIds,
} from "../../../src/app/renderer/test-ids.js";
import { NodeType } from "../../../src/core/flow/schema.js";

describe("test ids", () => {
  it.each(NodeType.options)("names the %s palette entry palette-<type>", (type) => {
    expect(paletteTestId(type)).toBe(`palette-${type}`);
  });

  it("names the note palette entry palette-note", () => {
    expect(paletteTestId("note")).toBe("palette-note");
  });

  it("names no palette-prompt or palette-script entry", () => {
    const ids = NodeType.options.map((type) => paletteTestId(type));

    expect(ids).toContain("palette-agent");
    expect(ids).not.toContain("palette-prompt");
    expect(ids).not.toContain("palette-script");
  });

  it("lists every control id", () => {
    expect(Object.values(controlTestIds)).toEqual([
      "canvas-save",
      "canvas-build",
      "nav-back",
      "flow-title",
      "menu-more",
      "menu-builds-live",
      "session-settings-open",
      "terminal-open",
      "menu-terminal-close",
      "sidebar-hide",
      "sidebar-show",
      "inspector-hide",
      "inspector-show",
      "sidebar-resize",
      "inspector-resize",
      "canvas-undo",
      "canvas-redo",
      "canvas-delete",
      "session-chip",
      "canvas-zoom-in",
      "canvas-zoom-out",
      "canvas-fit",
      "palette-search",
      "build-progress-stop",
      "build-model",
      "node-menu-duplicate",
      "node-menu-frame-only",
      "blueprint-terminal-toggle",
      "blueprint-terminal-minimize",
      "blueprint-terminal-close",
      "canvas-tidy",
    ]);
    expect(controlTestIds).not.toHaveProperty("fileWireName");
    expect(controlTestIds).not.toHaveProperty("built");
    expect(controlTestIds.menuBuildsLive).toBe("menu-builds-live");
  });

  it("lists the readouts", () => {
    expect(Object.values(readoutTestIds)).toEqual([
      "canvas-flow",
      "canvas-selection",
      "canvas-selected-wires",
    ]);
  });

  it("names the Build dialog's controls, one per declared variable", () => {
    expect(buildDialogTestIds).toMatchObject({
      dialog: "build-dialog",
      name: "build-dialog-name",
      repo: "build-dialog-repo",
      base: "build-dialog-base",
      repoBrowse: "build-dialog-repo-browse",
      baseInfo: "build-dialog-base-info",
      branchesError: "build-dialog-branches-error",
      confirm: "build-dialog-confirm",
      cancel: "build-dialog-cancel",
      error: "build-dialog-error",
      branchNew: "build-dialog-branch-new",
      branchExisting: "build-dialog-branch-existing",
      branchName: "build-dialog-branch-name",
    });
    expect(buildDialogTestIds.variable("ticket")).toBe("build-dialog-variable-ticket");
    expect(buildDialogTestIds.existingBranch("feat-y")).toBe("build-dialog-existing-branch-feat-y");
  });

  it("names each build card's controls by the build's id", () => {
    const id = "0f3a9c2e-1111-2222-3333-444455556666";

    expect([
      pageTestIds.buildCard(id),
      pageTestIds.buildOpen(id),
      pageTestIds.buildRun(id),
      pageTestIds.buildResume(id),
      pageTestIds.buildStop(id),
      pageTestIds.buildDelete(id),
      pageTestIds.buildOld(id),
      pageTestIds.buildKept(id),
    ]).toEqual([
      `build-card-${id}`,
      `build-open-${id}`,
      `build-run-${id}`,
      `build-resume-${id}`,
      `build-stop-${id}`,
      `build-delete-${id}`,
      `build-old-${id}`,
      `build-kept-${id}`,
    ]);
  });

  it("names the blueprint picture's controls by the build or pending build it shows", () => {
    expect([
      pageTestIds.buildPictureToggle("pb-1"),
      pageTestIds.buildPictureImage("pb-1"),
      pageTestIds.buildPictureEmpty("b-1"),
    ]).toEqual([
      "build-picture-toggle-pb-1",
      "build-picture-image-pb-1",
      "build-picture-empty-b-1",
    ]);
  });

  it("names the build tree's folders, the project row, its entries and the pipeline tree, none as a build-file- row", () => {
    expect([
      pageTestIds.buildFolder("plugin/agents"),
      pageTestIds.buildProject,
      pageTestIds.buildProjectToggle,
      pageTestIds.buildProjectEntry("shop/src"),
      pageTestIds.pipelineTree,
    ]).toEqual([
      "build-folder-plugin/agents",
      "build-project",
      "build-project-toggle",
      "build-project-entry-shop/src",
      "pipeline-tree",
    ]);
  });

  it("names a build in progress by its pending build", () => {
    expect([
      pageTestIds.buildingCard("pb-1"),
      pageTestIds.buildProgress("pb-1"),
      pageTestIds.buildStage("pb-1", 3, 2),
      pageTestIds.buildRow("pb-1", 3, 2, "agents/a.md"),
      pageTestIds.buildWorktree("pb-1"),
      pageTestIds.buildElapsed("pb-1"),
      pageTestIds.buildBuiltLink("pb-1"),
      pageTestIds.buildQuestion("pb-1", 0),
      pageTestIds.buildActivity("pb-1"),
      pageTestIds.buildTerminal("pb-1"),
      pageTestIds.buildCost("pb-1"),
    ]).toEqual([
      "building-card-pb-1",
      "build-progress-pb-1",
      "build-stage-pb-1-3-2",
      "build-row-pb-1-3-2-agents/a.md",
      "build-worktree-pb-1",
      "build-elapsed-pb-1",
      "build-built-link-pb-1",
      "build-question-pb-1-0",
      "build-activity-pb-1",
      "build-terminal-pb-1",
      "build-cost-pb-1",
    ]);
  });

  it("names nothing for a build on its blueprint, its canvas or the old progress view", () => {
    for (const gone of ["buildChip", "canvasBuildBar", "buildStep", "buildComponent"]) {
      expect(pageTestIds).not.toHaveProperty(gone);
    }
  });

  it("gives each stage per round, row per round and path, and question its own id", () => {
    const ids = [
      pageTestIds.buildingCard("pb-1"),
      pageTestIds.buildingCard("pb-2"),
      pageTestIds.buildStage("pb-1", 3, 1),
      pageTestIds.buildStage("pb-1", 3, 2),
      pageTestIds.buildStage("pb-1", 5, 1),
      pageTestIds.buildStage("pb-2", 3, 1),
      pageTestIds.buildRow("pb-1", 3, 1, "a.md"),
      pageTestIds.buildRow("pb-1", 3, 2, "a.md"),
      pageTestIds.buildRow("pb-1", 4, 1, "a.md"),
      pageTestIds.buildRow("pb-1", 3, 1, "b.md"),
      pageTestIds.buildRow("pb-2", 3, 1, "a.md"),
      pageTestIds.buildWorktree("pb-1"),
      pageTestIds.buildWorktree("pb-2"),
      pageTestIds.buildElapsed("pb-1"),
      pageTestIds.buildElapsed("pb-2"),
      pageTestIds.buildBuiltLink("pb-1"),
      pageTestIds.buildBuiltLink("pb-2"),
      pageTestIds.buildQuestion("pb-1", 0),
      pageTestIds.buildQuestion("pb-1", 1),
      pageTestIds.buildQuestion("pb-2", 0),
      pageTestIds.buildProgress("pb-1"),
      pageTestIds.buildCard("pb-1"),
    ];

    expect(new Set(ids).size).toBe(ids.length);
  });

  it("names a needs-you build's answer field per question and its Rebuild with answers control", () => {
    expect([
      pageTestIds.buildAnswer("pb-1", 0),
      pageTestIds.buildAnswer("pb-1", 1),
      pageTestIds.buildRebuild("pb-1"),
    ]).toEqual(["build-answer-pb-1-0", "build-answer-pb-1-1", "build-rebuild-pb-1"]);
  });

  it("gives each answer field and Rebuild control its own id, apart from the question ids", () => {
    const ids = [
      pageTestIds.buildQuestion("pb-1", 0),
      pageTestIds.buildQuestion("pb-1", 1),
      pageTestIds.buildAnswer("pb-1", 0),
      pageTestIds.buildAnswer("pb-1", 1),
      pageTestIds.buildAnswer("pb-2", 0),
      pageTestIds.buildRebuild("pb-1"),
      pageTestIds.buildRebuild("pb-2"),
      pageTestIds.buildProgress("pb-1"),
    ];

    expect(new Set(ids).size).toBe(ids.length);
  });

  it("names the Build configuration fields as the session form draws them", () => {
    expect(buildConfigTestIds).toMatchObject({
      repo: "session-build-config-repo",
      base: "session-build-config-base",
      repoBrowse: "session-build-config-repo-browse",
      baseInfo: "session-build-config-base-info",
      branchesError: "session-branches-error",
      addVariable: "build-config-add-variable",
    });
    expect(buildConfigTestIds.variable("deep")).toBe("build-config-variable-deep");
  });

  it("names the stop-agent confirm and its two answers", () => {
    expect(pageTestIds).toMatchObject({
      stopAgentDialog: "stop-agent-dialog",
      stopAgentConfirm: "stop-agent-confirm",
      stopAgentCancel: "stop-agent-cancel",
    });
  });

  it("names a blueprint card's Delete by the blueprint, its confirm and two answers", () => {
    expect(pageTestIds.blueprintDelete("flow-a")).toBe("blueprint-delete-flow-a");
    expect(pageTestIds).toMatchObject({
      blueprintDeleteDialog: "blueprint-delete-dialog",
      blueprintDeleteConfirm: "blueprint-delete-confirm",
      blueprintDeleteCancel: "blueprint-delete-cancel",
    });
  });

  it("names nothing on the run page that opens or mentions its blueprint", () => {
    expect(pageTestIds).not.toHaveProperty("runOpenBlueprint");
    expect(pageTestIds).not.toHaveProperty("runBlueprintDeleted");
  });

  it("names the stages a run did not record", () => {
    expect(pageTestIds.runStagesNotRecorded).toEqual(expect.any(String));
  });

  it("gives each run stage's dot, status, detail, reason, Retry and reply its own id per run, node and round", () => {
    const stageIds = [
      pageTestIds.runStage,
      pageTestIds.runStageStatus,
      pageTestIds.runStageDetail,
      pageTestIds.runStageReason,
      pageTestIds.runStageRetry,
      pageTestIds.runStageReply,
    ];
    const ids = stageIds.flatMap((id) => [
      id("run-1", "s1"),
      id("run-1", "s2"),
      id("run-2", "s1"),
      id("run-1", "s1", 1),
      id("run-1", "s1", 2),
    ]);

    expect(ids.every((id) => typeof id === "string" && id !== "")).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain(pageTestIds.runStagesNotRecorded);
  });

  it("gives each round header's cost its own id per run, container and round, apart from the round's stages", () => {
    const ids = [
      pageTestIds.runRoundCost("run-1", "loop", 1),
      pageTestIds.runRoundCost("run-1", "loop", 2),
      pageTestIds.runRoundCost("run-1", "each", 1),
      pageTestIds.runRoundCost("run-2", "loop", 1),
    ];

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain(pageTestIds.runStage("run-1", "loop", 1));
  });

  it("names a run stage apart from a build stage given the same arguments", () => {
    const stageIds = [
      pageTestIds.runStage,
      pageTestIds.runStageStatus,
      pageTestIds.runStageDetail,
      pageTestIds.runStageReason,
      pageTestIds.runStageRetry,
      pageTestIds.runStageReply,
    ];

    for (const id of stageIds) {
      expect(id("pb-1", "3", 2)).not.toBe(pageTestIds.buildStage("pb-1", 3, 2));
    }
  });

  it("names the Branch variable picker and the Doctor's worktree list", () => {
    expect(branchVariableTestId).toBe("node-setting-variable");
    expect(branchDecidedByTestId).toBe("node-setting-decided-by");
    expect(branchValueTestId).toBe("node-setting-value");
    expect(agentProducesTestId).toBe("node-setting-produces");
    expect(pageTestIds.doctorWorktrees).toBe("doctor-worktrees");
  });

  it("gives every control its own id, and a parameterised id its own id per value", () => {
    const groups = [
      controlTestIds,
      readoutTestIds,
      pageTestIds,
      dialogTestIds,
      buildDialogTestIds,
      buildConfigTestIds,
      { branchVariableTestId, branchDecidedByTestId, branchValueTestId, agentProducesTestId },
    ];
    const ids = groups.flatMap((group) =>
      Object.values(group).flatMap((id: string | ((value: string) => string)) =>
        typeof id === "string" ? [id] : [id("a"), id("b")],
      ),
    );

    expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([]);
  });
});
