import { expect, test } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { controlTestIds, pageTestIds, readoutTestIds } from "../src/app/renderer/test-ids.js";
import type { Flow } from "../src/core/flow/schema.js";
import {
  agent,
  flow,
  flowSettings,
  output,
  thenWire,
  trigger,
} from "../test/fixtures/flow-builders.js";
import { seedBlueprint } from "../test/fixtures/seed-flow.js";
import { type LaunchedApp } from "../scripts/drive.js";
import { launchWithFakeClaude } from "./fake-claude.js";
import { killRunSessions } from "./run-sessions.js";

let home: string;
let launched: LaunchedApp | undefined;

test.beforeEach(async () => {
  launched = undefined;
  home = await mkdtemp(join(tmpdir(), "fd-ub-"));
});

test.afterEach(async () => {
  try {
    await launched?.close();
  } finally {
    await killRunSessions(home);
    await rm(home, { recursive: true, force: true });
  }
});

const placedInLine = <T extends object>(nodes: T[]) =>
  nodes.map((node, index) => ({ ...node, position: { x: index * 260, y: 0 } }));

const reviewLibrary = (): Flow =>
  flow(
    placedInLine([trigger("start"), { ...agent("review"), label: "Review" }, output("stop")]),
    [thenWire("start", "review"), thenWire("review", "stop")],
    flowSettings,
    { containers: [] },
  );

const libraryUsing = (libraryId: string): Flow =>
  flow(
    placedInLine([
      trigger("start"),
      {
        id: "use-b",
        label: "Library",
        position: { x: 0, y: 0 },
        type: "library",
        settings: { libraryId, label: "B", overrides: {} },
      },
      output("stop"),
    ]),
    [thenWire("start", "use-b"), thenWire("use-b", "stop")],
    flowSettings,
    { containers: [] },
  );

test("A library in use cannot be deleted; once its use is removed it deletes and its former user still opens", async () => {
  const b = seedBlueprint(home, "B", reviewLibrary());
  const a = seedBlueprint(home, "A", libraryUsing(b.flowId));
  launched = await launchWithFakeClaude({ home, logPath: test.info().outputPath("app.log") });
  const { window } = launched;
  await window.getByTestId(controlTestIds.back).or(window.getByTestId("menu-blueprints")).click();

  const bCard = window.getByTestId(pageTestIds.blueprintCard(b.flowId));
  const dialog = window.getByTestId(pageTestIds.blueprintDeleteDialog);
  await expect(bCard).toBeVisible();

  await window.getByTestId(pageTestIds.blueprintDelete(b.flowId)).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId(pageTestIds.usedByOpen("delete", b.flowId, a.flowId))).toHaveText(
    "A",
  );
  await expect(dialog.getByTestId(pageTestIds.blueprintDeleteConfirm)).toHaveCount(0);
  await window.getByTestId(pageTestIds.blueprintDeleteCancel).click();
  await expect(dialog).toBeHidden();
  await expect(bCard).toBeVisible();

  await window.getByTestId(pageTestIds.blueprintOpen(a.flowId)).click();
  await window.getByTestId("node-use-b").click();
  await window.getByTestId(controlTestIds.delete).click();
  await expect(window.getByTestId("node-use-b")).toHaveCount(0);
  await window.getByTestId(controlTestIds.save).click();
  await expect(window.getByTestId("flow-unsaved")).toHaveCount(0);

  await window.getByTestId(controlTestIds.back).or(window.getByTestId("menu-blueprints")).click();
  await window.getByTestId(pageTestIds.blueprintDelete(b.flowId)).click();
  await expect(dialog).toBeVisible();
  await window.getByTestId(pageTestIds.blueprintDeleteConfirm).click();
  await expect(dialog).toBeHidden();
  await expect(window.getByTestId(pageTestIds.blueprintOpen(b.flowId))).toHaveCount(0);

  await window.getByTestId(pageTestIds.blueprintOpen(a.flowId)).click();
  await expect(window.getByTestId(controlTestIds.save)).toBeVisible();
  const opened = JSON.parse(
    (await window.getByTestId(readoutTestIds.flow).textContent()) ?? "",
  ) as Flow;
  expect(opened.nodes.map((node) => node.id)).toEqual(["start", "stop"]);
});
