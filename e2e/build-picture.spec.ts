import { expect, test, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteFlowStore } from "../src/adapters/sqlite/flows.js";
import { openDatabase } from "../src/adapters/sqlite/open-database.js";
import { controlTestIds, pageTestIds } from "../src/app/renderer/test-ids.js";
import { agent, onMainFlow } from "../test/fixtures/flow-builders.js";
import { seedBlueprint } from "../test/fixtures/seed-flow.js";
import { createTmpRepo, type TmpRepo } from "../test/fixtures/tmp-repo.js";
import { type LaunchedApp } from "../scripts/drive.js";
import { launchWithFakeClaude } from "./fake-claude.js";
import { buildOnCanvas, runFromDetail } from "./build-run.js";
import { killRunSessions } from "./run-sessions.js";

let home: string;
let repo: TmpRepo;
let launched: LaunchedApp | undefined;

const oneAgent = () => onMainFlow([{ ...agent("s1"), label: "Old label" }], []);

const openBlueprint = async (window: Page, flowId: string) => {
  await window.getByTestId(controlTestIds.back).or(window.getByTestId("menu-blueprints")).click();
  await window.getByTestId(pageTestIds.blueprintOpen(flowId)).click();
  await expect(window.getByTestId(controlTestIds.build)).toBeVisible();
};

const latestLabel = (flowId: string): string | undefined => {
  const db = openDatabase({ path: join(home, "flowdeck.db") });
  try {
    return new SqliteFlowStore({ db }).loadLatest(flowId)?.flow.nodes.find(({ id }) => id === "s1")
      ?.label;
  } finally {
    db.close();
  }
};

const expectPictureWithOldLabel = async (window: Page, buildId: string) => {
  await window.getByTestId(pageTestIds.buildPictureToggle(buildId)).click();
  const image = window.getByTestId(pageTestIds.buildPictureImage(buildId));
  await expect(image).toBeVisible();
  await expect(image).toHaveAttribute("alt", "Blueprint at build time");
  const src = (await image.getAttribute("src")) ?? "";
  expect(src.startsWith("data:image/svg+xml")).toBe(true);
  const svg = decodeURIComponent(src.slice(src.indexOf(",") + 1));
  expect(svg).toContain("Old label");
  expect(svg).not.toContain("New label");
};

test.beforeEach(async () => {
  launched = undefined;
  home = await mkdtemp(join(tmpdir(), "fd-pic-"));
  repo = await createTmpRepo({ commit: true });
});

test.afterEach(async () => {
  try {
    await launched?.close();
  } finally {
    await killRunSessions(home);
    await rm(home, { recursive: true, force: true });
    await repo.cleanup();
  }
});

test("The build page and the run page show the blueprint as it was built, not as it is now", async () => {
  const { flowId } = seedBlueprint(home, "Fixer", oneAgent(), repo.path);
  launched = await launchWithFakeClaude({ home, logPath: test.info().outputPath("app.log") });
  const { window } = launched;
  await openBlueprint(window, flowId);
  const buildId = await buildOnCanvas(window, home, "fix-a");

  await openBlueprint(window, flowId);
  await window.getByTestId("node-s1").click();
  const label = window.getByTestId("node-label");
  await label.fill("New label");
  await label.blur();
  await window.getByTestId(controlTestIds.save).click();
  await expect(window.getByTestId("flow-unsaved")).toHaveCount(0);
  await expect.poll(() => latestLabel(flowId)).toBe("New label");

  await window.getByTestId(controlTestIds.back).click();
  await window.getByTestId("menu-builds").click();
  await window.getByTestId(pageTestIds.buildOpen(buildId)).click();
  await expect(window.getByTestId(pageTestIds.buildDetailRun)).toBeVisible();
  await expectPictureWithOldLabel(window, buildId);

  await runFromDetail(window);
  await expect(window.getByTestId(pageTestIds.runPageStatus)).toBeVisible();
  await expectPictureWithOldLabel(window, buildId);
});
