import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { flow, gate, output, thenWire, trigger } from "../test/fixtures/flow-builders.js";
import { dialogTestIds, pageTestIds } from "../src/app/renderer/test-ids.js";
import { seedBlueprint } from "../test/fixtures/seed-flow.js";
import { createTmpRepo, type TmpRepo } from "../test/fixtures/tmp-repo.js";
import { type LaunchedApp } from "../scripts/drive.js";
import { launchWithFakeClaude } from "./fake-claude.js";
import { buildOnCanvas, runFromDetail, runIdOf } from "./build-run.js";
import { killRunSessions } from "./run-sessions.js";

const fakeStory = "Fake story: the run ended.";

let home: string;
let repo: TmpRepo;
let launched: LaunchedApp | undefined;

test.beforeEach(async () => {
  launched = undefined;
  home = await mkdtemp(join(tmpdir(), "fd-rs-"));
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

const startRun = async (env: Record<string, string>, skippable: boolean) => {
  seedBlueprint(
    home,
    "Gate check",
    flow(
      [
        trigger("start"),
        gate("g1", { settings: { shown: "Check the plan", skippable } }),
        output("stop"),
      ],
      [thenWire("start", "g1"), thenWire("g1", "stop")],
    ),
    repo.path,
  );
  const logPath = test.info().outputPath("app.log");
  launched = await launchWithFakeClaude({ home, logPath, env });
  const { window } = launched;
  await expect(window.getByTestId("canvas-build")).toBeVisible();

  const buildId = await buildOnCanvas(window, home, "story-run");
  if (skippable) {
    await window.getByTestId(pageTestIds.buildDetailRun).click();
    await window.getByTestId(dialogTestIds.auto).check();
    await window.getByTestId(dialogTestIds.start).click();
  } else {
    await runFromDetail(window);
  }
  const runId = await runIdOf(home, buildId);
  return { window, runId, logPath };
};

const runToTheEnd = async (env: Record<string, string> = {}) => {
  const started = await startRun(env, true);
  await expect(started.window.getByTestId(pageTestIds.runPageStatus)).toHaveText("done", {
    timeout: 20_000,
  });
  return started;
};

const storyOrder = (window: Page) =>
  window
    .getByTestId(pageTestIds.runStory)
    .locator("[data-testid]")
    .evaluateAll(
      (elements, parts: string[]) =>
        elements
          .map((element) => element.getAttribute("data-testid"))
          .filter((id) => id !== null && parts.includes(id)),
      [pageTestIds.runStoryHeader, pageTestIds.runStoryAccount, pageTestIds.runStoryDigest],
    );

const openDigest = async (window: Page) => {
  const toggle = window.getByTestId(pageTestIds.runStoryDigestToggle);
  await expect(toggle).toHaveAttribute("aria-expanded", "false", { timeout: 20_000 });
  await expect(window.getByTestId(pageTestIds.runStoryDigest)).toHaveCount(0);
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
};

const expectHeaderAndDigest = async (window: Page) => {
  const header = window.getByTestId(pageTestIds.runStoryHeader);
  await expect(header).toContainText("story-run", { timeout: 20_000 });
  await expect(header).toContainText("Gate check");
  await expect(header).toContainText("v1");
  await expect(header).toContainText(repo.path);
  await openDigest(window);
  await expect(window.getByTestId(pageTestIds.runStoryDigest)).toContainText(
    "Asked: Check the plan",
  );
};

test("A run that ends shows its Story while the page stays open: header, the written account, then the digest behind a collapsed toggle, and the account's first line on its Runs row", async () => {
  const { window, runId } = await runToTheEnd();

  await expectHeaderAndDigest(window);
  await expect(window.getByTestId(pageTestIds.runStoryAccount)).toContainText(fakeStory, {
    timeout: 20_000,
  });
  expect(await storyOrder(window)).toEqual([
    pageTestIds.runStoryHeader,
    pageTestIds.runStoryAccount,
    pageTestIds.runStoryDigest,
  ]);

  await window.getByTestId(pageTestIds.runBack).click();
  await expect(
    window.getByTestId(pageTestIds.runCard(runId)).getByTestId(pageTestIds.runRowStoryLine),
  ).toHaveText(fakeStory);
});

test("When the narrator fails, the Story still shows header and digest, with no account, and the Runs row has no story line", async () => {
  const { window, runId, logPath } = await runToTheEnd({ FAKE_CLAUDE_NARRATE_FAIL: "1" });

  await expect
    .poll(() => readFileSync(logPath, "utf8"), { timeout: 20_000 })
    .toContain(`run ${runId} story not written (`);
  await expectHeaderAndDigest(window);
  await expect(window.getByTestId(pageTestIds.runStoryAccount)).toHaveCount(0);
  expect(await storyOrder(window)).toEqual([
    pageTestIds.runStoryHeader,
    pageTestIds.runStoryDigest,
  ]);

  await window.getByTestId(pageTestIds.runBack).click();
  const card = window.getByTestId(pageTestIds.runCard(runId));
  await expect(card).toBeVisible();
  await expect(card.getByTestId(pageTestIds.runRowStoryLine)).toHaveCount(0);
});

test("A run approved at its gate while its page stays open: the digest says running while it waits, then done, with no account when the narrator fails", async () => {
  const { window, runId, logPath } = await startRun({ FAKE_CLAUDE_NARRATE_FAIL: "1" }, false);
  const digest = window.getByTestId(pageTestIds.runStoryDigest);

  await expect(window.getByTestId("wait-panel")).toBeVisible({ timeout: 20_000 });
  await openDigest(window);
  await expect(digest).toContainText("Run status: running");
  await window.getByTestId("wait-approve").click();

  await expect(window.getByTestId(pageTestIds.runPageStatus)).toHaveText("done", {
    timeout: 20_000,
  });
  await expect(digest).toContainText("Run status: done", { timeout: 20_000 });
  await expect
    .poll(() => readFileSync(logPath, "utf8"), { timeout: 20_000 })
    .toContain(`run ${runId} story not written (`);
  await expect(window.getByTestId(pageTestIds.runStoryAccount)).toHaveCount(0);
});
