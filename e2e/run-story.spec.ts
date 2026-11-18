import { expect, test, type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agent, flow, gate, output, thenWire, trigger } from "../test/fixtures/flow-builders.js";
import { controlTestIds, dialogTestIds, pageTestIds } from "../src/app/renderer/test-ids.js";
import { seedBlueprint } from "../test/fixtures/seed-flow.js";
import { createTmpRepo, type TmpRepo } from "../test/fixtures/tmp-repo.js";
import { type LaunchedApp } from "../scripts/drive.js";
import { launchWithFakeClaude } from "./fake-claude.js";
import { buildOnCanvas, runFromDetail, runIdOf } from "./build-run.js";
import { killRunSessions } from "./run-sessions.js";

const fakeResult = "The fake run ended.";
const storyParts = ["story-context", "story-goal", "story-result"];

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

const branchOf = (runId: string) => {
  const db = new Database(join(home, "flowdeck.db"), { readonly: true });
  try {
    const row = db.prepare("SELECT branch FROM runs WHERE id = ?").get(runId) as
      { branch: string | null } | undefined;
    return row?.branch ?? null;
  } finally {
    db.close();
  }
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

const partsOrder = (window: Page) =>
  window
    .getByTestId(pageTestIds.runStory)
    .locator("[data-testid]")
    .evaluateAll(
      (elements, parts: string[]) =>
        elements
          .map((element) => element.getAttribute("data-testid"))
          .filter((id) => id !== null && parts.includes(id)),
      storyParts,
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

test("A run that ends shows its Story while the page stays open: header with repo and branch, the account in Context, Goal and Result parts, then the digest behind a collapsed toggle, and the Result on its Runs row", async () => {
  const { window, runId } = await runToTheEnd();
  const branch = branchOf(runId);
  expect(branch).toEqual(expect.any(String));

  await expectHeaderAndDigest(window);
  await expect(window.getByTestId(pageTestIds.runStoryHeader)).toHaveText(
    ["story-run", "Gate check v1", repo.path, branch ?? ""].join(""),
  );
  await expect(window.getByTestId(pageTestIds.runStoryOtherRepos)).toHaveCount(0);
  await expect(window.getByTestId(pageTestIds.runStoryDigest)).toContainText("Before: ");
  await expect(window.getByTestId(pageTestIds.runStoryDigest)).toContainText("After: ");
  await expect(window.getByTestId(pageTestIds.runStoryAccount)).toContainText(fakeResult, {
    timeout: 20_000,
  });
  await expect(window.getByTestId("story-context")).toHaveText(/The fake repo sat on its branch\./);
  await expect(window.getByTestId("story-goal")).toHaveText(/The fake run was meant to end\./);
  await expect(window.getByTestId("story-result")).toHaveText(/The fake run ended\./);
  expect(await partsOrder(window)).toEqual(storyParts);
  expect(await storyOrder(window)).toEqual([
    pageTestIds.runStoryHeader,
    pageTestIds.runStoryAccount,
    pageTestIds.runStoryDigest,
  ]);
  await expect(window.getByTestId(pageTestIds.runStoryWrite)).toHaveCount(0);

  await window.getByTestId(pageTestIds.runBack).click();
  await expect(
    window.getByTestId(pageTestIds.runCard(runId)).getByTestId(pageTestIds.runRowStoryLine),
  ).toHaveText(fakeResult);
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
  const branch = branchOf(runId);
  expect(branch).toEqual(expect.any(String));
  await expect(digest).toContainText(`Branch: ${branch ?? ""}`);
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

test("An ended run with no story offers Write story: it shows the narrator's error, and after a relaunch with a working narrator it writes the story and the button goes", async () => {
  const { window, runId, logPath } = await runToTheEnd({ FAKE_CLAUDE_NARRATE_FAIL: "1" });
  await expect
    .poll(() => readFileSync(logPath, "utf8"), { timeout: 20_000 })
    .toContain(`run ${runId} story not written (`);

  const write = window.getByTestId(pageTestIds.runStoryWrite);
  await expect(write).toBeVisible();
  await write.click();
  await expect(window.getByTestId(pageTestIds.runStoryWriteError)).toBeVisible({
    timeout: 20_000,
  });
  await expect(window.getByTestId(pageTestIds.runStoryAccount)).toHaveCount(0);

  const first = launched;
  launched = undefined;
  await first?.close();
  launched = await launchWithFakeClaude({ home, logPath: test.info().outputPath("app-2.log") });
  const reopened = launched.window;
  await expect(reopened.getByTestId("canvas-build")).toBeVisible();
  await reopened.getByTestId(controlTestIds.back).click();
  await reopened.getByTestId("menu-runs").click();
  await reopened.getByTestId(pageTestIds.runOpen(runId)).click();
  await expect(reopened.getByTestId(pageTestIds.runPageStatus)).toHaveText("done");

  await reopened.getByTestId(pageTestIds.runStoryWrite).click();

  await expect(reopened.getByTestId(pageTestIds.runStoryAccount)).toContainText(fakeResult, {
    timeout: 20_000,
  });
  await expect(reopened.getByTestId(pageTestIds.runStoryWrite)).toHaveCount(0);
  await expect(reopened.getByTestId(pageTestIds.runStoryWriteError)).toHaveCount(0);
});

const committer = [
  "-c",
  "user.name=Flowdeck Test",
  "-c",
  "user.email=test@flowdeck.invalid",
  "-c",
  "commit.gpgsign=false",
];

const otherRepoOnMaster = async () => {
  const path = join(await realpath(home), "other-repo");
  await mkdir(path);
  execFileSync("git", ["init", "--quiet", "--initial-branch=master"], { cwd: path });
  execFileSync("git", [...committer, "commit", "--quiet", "--allow-empty", "-m", "initial"], {
    cwd: path,
  });
  return path;
};

const headOf = (path: string) =>
  execFileSync("git", ["-C", path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

const otherRepoBefores = (runId: string) => {
  const db = new Database(join(home, "flowdeck.db"), { readonly: true });
  try {
    return (
      db
        .prepare(
          "SELECT repo, state_json FROM run_repo_states WHERE run_id = ? AND phase = 'before' AND repo IS NOT NULL",
        )
        .all(runId) as { repo: string; state_json: string }[]
    ).map((row) => ({ repo: row.repo, state: JSON.parse(row.state_json) as { head?: string } }));
  } finally {
    db.close();
  }
};

test("A run whose agent commits in another repo names that repo and its branch in the Story header, with its Before at the old HEAD and its After at the new one", async () => {
  const otherRepo = await otherRepoOnMaster();
  const oldHead = headOf(otherRepo);
  seedBlueprint(
    home,
    "Other repo",
    flow(
      [trigger("start"), agent("s1"), output("stop")],
      [thenWire("start", "s1"), thenWire("s1", "stop")],
    ),
    repo.path,
  );
  launched = await launchWithFakeClaude({
    home,
    logPath: test.info().outputPath("app.log"),
    stepCommand: `cd ${otherRepo} && git commit --allow-empty -m change`,
    stepCommitIn: otherRepo,
  });
  const { window } = launched;
  await expect(window.getByTestId("canvas-build")).toBeVisible();
  const buildId = await buildOnCanvas(window, home, "other-repo-run");
  await runFromDetail(window);
  const runId = await runIdOf(home, buildId);
  await expect(window.getByTestId(pageTestIds.runPageStatus)).toHaveText("done", {
    timeout: 20_000,
  });
  const newHead = headOf(otherRepo);
  expect(newHead).not.toBe(oldHead);

  const header = window.getByTestId(pageTestIds.runStoryHeader);
  await expect(header).toContainText(otherRepo, { timeout: 20_000 });
  await expect(header).toContainText("master");
  const other = window.getByTestId(pageTestIds.runStoryOtherRepos);
  await expect(other).toContainText(`${otherRepo} · master`);
  await expect(other).toContainText(`Before: on master at ${oldHead.slice(0, 7)}`);
  await expect(other).toContainText(`After: on master at ${newHead.slice(0, 7)}`);
  await expect(other).not.toContainText("not recorded");
  await expect(other.locator("li > div")).toHaveText([
    /^Before: on master at /,
    /^After: on master at /,
  ]);
  expect(await other.innerText()).toMatch(/untracked\nAfter: /);

  expect(otherRepoBefores(runId)).toEqual([
    { repo: otherRepo, state: expect.objectContaining({ head: oldHead.slice(0, 7) }) },
  ]);
});
