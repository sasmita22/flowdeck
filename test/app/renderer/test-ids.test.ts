import { describe, expect, it } from "vitest";
import {
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
      "editor-built",
      "nav-back",
      "flow-title",
      "menu-more",
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
      expect.any(Function),
      "node-menu-duplicate",
      "node-menu-frame-only",
      "blueprint-terminal-toggle",
      "blueprint-terminal-minimize",
      "blueprint-terminal-close",
    ]);
    expect(controlTestIds.fileWireName("a->b:notes.md")).toBe("file-wire-name-a->b:notes.md");
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
    });
    expect(buildDialogTestIds.variable("ticket")).toBe("build-dialog-variable-ticket");
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

  it("names a build in progress by its blueprint and its pending build", () => {
    expect(Object.keys(pageTestIds)).toEqual(
      expect.arrayContaining([
        "buildChip",
        "canvasBuildBar",
        "buildProgress",
        "buildStep",
        "buildComponent",
        "buildQuestion",
        "buildActivity",
        "buildTerminal",
        "buildCost",
      ]),
    );
    expect([
      pageTestIds.buildChip("f1"),
      pageTestIds.canvasBuildBar,
      pageTestIds.buildProgress("pb-1"),
      pageTestIds.buildStep("pb-1", 2),
      pageTestIds.buildComponent("pb-1", "steps/02.md"),
      pageTestIds.buildQuestion("pb-1", 0),
      pageTestIds.buildActivity("pb-1"),
      pageTestIds.buildTerminal("pb-1"),
      pageTestIds.buildCost("pb-1"),
    ]).toEqual([
      "build-chip-f1",
      "canvas-build-bar",
      "build-progress-pb-1",
      "build-step-pb-1-2",
      "build-component-pb-1-steps/02.md",
      "build-question-pb-1-0",
      "build-activity-pb-1",
      "build-terminal-pb-1",
      "build-cost-pb-1",
    ]);
  });

  it("gives each step, component and question of a pending build its own id", () => {
    expect(Object.keys(pageTestIds)).toEqual(
      expect.arrayContaining(["buildStep", "buildComponent", "buildQuestion"]),
    );
    const ids = [
      pageTestIds.buildStep("pb-1", 1),
      pageTestIds.buildStep("pb-1", 2),
      pageTestIds.buildStep("pb-2", 1),
      pageTestIds.buildComponent("pb-1", "a.md"),
      pageTestIds.buildComponent("pb-1", "b.md"),
      pageTestIds.buildComponent("pb-2", "a.md"),
      pageTestIds.buildQuestion("pb-1", 0),
      pageTestIds.buildQuestion("pb-1", 1),
      pageTestIds.buildQuestion("pb-2", 0),
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

  it("names the Branch variable picker and the Doctor's worktree list", () => {
    expect(branchVariableTestId).toBe("node-setting-variable");
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
      { branchVariableTestId },
    ];
    const ids = groups.flatMap((group) =>
      Object.values(group).flatMap((id: string | ((value: string) => string)) =>
        typeof id === "string" ? [id] : [id("a"), id("b")],
      ),
    );

    expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([]);
  });
});
