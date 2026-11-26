import { expect, test } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { controlTestIds, pageTestIds } from "../src/app/renderer/test-ids.js";
import { agent, onMainFlow } from "../test/fixtures/flow-builders.js";
import { seedBlueprint } from "../test/fixtures/seed-flow.js";
import { createTmpRepo, type TmpRepo } from "../test/fixtures/tmp-repo.js";
import { type LaunchedApp } from "../scripts/drive.js";
import { launchWithFakeClaude } from "./fake-claude.js";
import { buildOnCanvas } from "./build-run.js";
import { endSessionsOfHome } from "./own-sessions.js";

let home: string;
let repo: TmpRepo;
let launched: LaunchedApp | undefined;

const oneAgent = () => {
  const built = onMainFlow([{ ...agent("s1"), label: "Doomed step" }], []);
  return {
    ...built,
    nodes: built.nodes.map((node, index) => ({ ...node, position: { x: index * 240, y: 0 } })),
  };
};

test.beforeEach(async () => {
  launched = undefined;
  home = await mkdtemp(join(tmpdir(), "fd-del-"));
  repo = await createTmpRepo({ commit: true });
});

test.afterEach(async () => {
  try {
    await launched?.close();
  } finally {
    try {
      await endSessionsOfHome(home);
      await rm(home, { recursive: true, force: true });
    } finally {
      await repo.cleanup();
    }
  }
});

test("Deleting a blueprint from its card asks first; Cancel keeps it, Delete removes it and keeps its build and picture", async () => {
  const { flowId } = seedBlueprint(home, "Doomed", oneAgent(), repo.path);
  launched = await launchWithFakeClaude({ home, logPath: test.info().outputPath("app.log") });
  const { window } = launched;
  await window.getByTestId(controlTestIds.back).click();
  await window.getByTestId(pageTestIds.blueprintOpen(flowId)).click();
  await expect(window.getByTestId(controlTestIds.build)).toBeVisible();
  const buildId = await buildOnCanvas(window, home, "keep-me");

  await window.getByTestId("menu-blueprints").click();
  const card = window.getByTestId(pageTestIds.blueprintCard(flowId));
  const dialog = window.getByTestId(pageTestIds.blueprintDeleteDialog);
  await expect(card).toBeVisible();

  await window.getByTestId(pageTestIds.blueprintDelete(flowId)).click();
  await expect(dialog).toBeVisible();
  await window.getByTestId(pageTestIds.blueprintDeleteCancel).click();
  await expect(dialog).toBeHidden();
  await expect(card).toBeVisible();

  await window.getByTestId(pageTestIds.blueprintDelete(flowId)).click();
  await expect(dialog).toBeVisible();
  await window.getByTestId(pageTestIds.blueprintDeleteConfirm).click();
  await expect(dialog).toBeHidden();
  await expect(card).toHaveCount(0);

  await window.getByTestId("menu-builds").click();
  await expect(window.getByTestId(pageTestIds.buildCard(buildId))).toBeVisible();
  await window.getByTestId(pageTestIds.buildOpen(buildId)).click();
  await window.getByTestId(pageTestIds.buildPictureToggle(buildId)).click();
  const image = window.getByTestId(pageTestIds.buildPictureImage(buildId));
  await expect(image).toBeVisible();
  const src = (await image.getAttribute("src")) ?? "";
  expect(src.startsWith("data:image/svg+xml")).toBe(true);
  expect(decodeURIComponent(src.slice(src.indexOf(",") + 1))).toContain("Doomed step");
});
