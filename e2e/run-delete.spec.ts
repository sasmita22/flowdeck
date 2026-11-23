import { expect, test, type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { controlTestIds, pageTestIds } from "../src/app/renderer/test-ids.js";
import { agent, onWorkspaceMainFlow } from "../test/fixtures/flow-builders.js";
import { seedBlueprint } from "../test/fixtures/seed-flow.js";
import { createTmpRepo, type TmpRepo } from "../test/fixtures/tmp-repo.js";
import { type LaunchedApp } from "../scripts/drive.js";
import { launchWithFakeClaude, type FakeAgentTurn } from "./fake-claude.js";
import { buildAndRun, runFromDetail, runIdOf } from "./build-run.js";
import { killRunSessions } from "./run-sessions.js";

const run = promisify(execFile);
const watchMs = 20_000;

let home: string;
let repo: TmpRepo;
let launched: LaunchedApp | undefined;

const rows = <T>(sql: string, ...params: string[]): T[] => {
  const db = new Database(join(home, "flowdeck.db"), { readonly: true });
  try {
    return db.prepare(sql).all(...params) as T[];
  } finally {
    db.close();
  }
};

const runsOfBuild = (buildId: string) =>
  rows<{ id: string }>("SELECT id FROM runs WHERE build_id = ? ORDER BY rowid", buildId).map(
    ({ id }) => id,
  );

const runRows = (runId: string) => rows<{ id: string }>("SELECT id FROM runs WHERE id = ?", runId);

const tmuxAlive = async (name: string) => {
  try {
    await run("tmux", ["-L", name, "has-session", "-t", `=${name}`]);
    return true;
  } catch {
    return false;
  }
};

const oneAgent = () => {
  const built = onWorkspaceMainFlow([agent("p1")], []);
  return {
    ...built,
    nodes: built.nodes.map((node, index) => ({ ...node, position: { x: index * 240, y: 0 } })),
  };
};

const launch = async (turns?: Record<string, FakeAgentTurn>) => {
  launched = await launchWithFakeClaude({
    home,
    logPath: test.info().outputPath("app.log"),
    ...(turns === undefined ? {} : { turns }),
  });
  await expect(launched.window.getByTestId(controlTestIds.build)).toBeVisible();
  return launched.window;
};

const finished = (window: Page) =>
  expect(window.getByTestId(pageTestIds.runPageStatus)).toHaveAttribute("data-status", "done", {
    timeout: watchMs,
  });

test.beforeEach(async () => {
  launched = undefined;
  home = await mkdtemp(join(tmpdir(), "fd-rd-"));
  repo = await createTmpRepo({ commit: true });
});

test.afterEach(async () => {
  try {
    const current = launched;
    launched = undefined;
    await current?.close();
  } finally {
    await killRunSessions(home);
    await rm(home, { recursive: true, force: true });
    await repo.cleanup();
  }
});

test("A Runs row has a ⋯ and no Delete button; deleting a done run from Runs removes it there and from its build's runs, and the others keep their numbers", async () => {
  seedBlueprint(home, "Alpha", oneAgent(), repo.path);
  const window = await launch();
  const buildId = await buildAndRun(window, home, "alpha");
  await finished(window);
  for (const count of [2, 3]) {
    await window.getByTestId(pageTestIds.runAgain).click();
    await expect.poll(() => runsOfBuild(buildId).length, { timeout: watchMs }).toBe(count);
    await finished(window);
  }
  const [first, second, third] = runsOfBuild(buildId);
  if (first === undefined || second === undefined || third === undefined) {
    throw new Error("the three runs were not recorded");
  }

  await window.getByTestId(pageTestIds.runBack).click();
  const trigger = window.getByTestId(pageTestIds.runMenu(second));
  const del = window.getByTestId(pageTestIds.runDelete(second));
  await expect(window.getByTestId(pageTestIds.runCard(second))).toContainText("#2 alpha");
  await expect(trigger).toBeVisible();
  await expect(del).toHaveCount(0);

  await trigger.click();
  await expect(del).toBeVisible();
  await window.keyboard.press("Escape");
  await expect(del).toHaveCount(0);
  await trigger.click();
  await expect(del).toBeVisible();
  await window.getByTestId(pageTestIds.title).click();
  await expect(del).toHaveCount(0);

  await trigger.click();
  await del.click();
  await window.getByTestId(pageTestIds.deletePromptConfirm).click();

  await expect(window.getByTestId(pageTestIds.runCard(second))).toHaveCount(0);
  await expect(window.getByTestId(pageTestIds.runCard(first))).toContainText("#1 alpha");
  await expect(window.getByTestId(pageTestIds.runCard(third))).toContainText("#3 alpha");
  expect(runRows(second)).toEqual([]);
  expect(runsOfBuild(buildId)).toEqual([first, third]);

  await window.getByTestId("menu-builds").click();
  await window.getByTestId(pageTestIds.buildOpen(buildId)).click();
  const buildRuns = window.getByTestId(pageTestIds.buildRuns);
  await expect(buildRuns.getByTestId(pageTestIds.runCard(first))).toContainText("#1 alpha");
  await expect(buildRuns.getByTestId(pageTestIds.runCard(third))).toContainText("#3 alpha");
  await expect(buildRuns.getByTestId(pageTestIds.runCard(second))).toHaveCount(0);
});

test("Deleting a going run from its page stops it, lands on Runs without it, and the build can start a new run", async () => {
  seedBlueprint(home, "Alpha", oneAgent(), repo.path);
  const window = await launch({ p1: "hold-once" });
  const buildId = await buildAndRun(window, home, "busy");
  const runId = await runIdOf(home, buildId);
  await expect(window.getByTestId(pageTestIds.runStageStatus(runId, "p1"))).toHaveAttribute(
    "data-status",
    "sent",
    { timeout: watchMs },
  );
  const [session] = rows<{ tmux_name: string }>(
    "SELECT tmux_name FROM run_sessions WHERE run_id = ?",
    runId,
  );
  const tmuxName = session?.tmux_name ?? "";
  await expect.poll(() => tmuxAlive(tmuxName)).toBe(true);

  await window.getByTestId(pageTestIds.runPageMenu).click();
  await window.getByTestId(pageTestIds.runPageDelete).click();
  await window.getByTestId(pageTestIds.deletePromptConfirm).click();

  await expect(window.getByTestId(pageTestIds.title)).toHaveText("Runs", { timeout: watchMs });
  await expect(window.getByTestId(pageTestIds.runCard(runId))).toHaveCount(0);
  await expect.poll(() => tmuxAlive(tmuxName), { timeout: watchMs }).toBe(false);
  expect(runRows(runId)).toEqual([]);
  expect(runsOfBuild(buildId)).toEqual([]);

  await window.getByTestId("menu-builds").click();
  await window.getByTestId(pageTestIds.buildOpen(buildId)).click();
  await runFromDetail(window);
  await expect.poll(() => runsOfBuild(buildId).length, { timeout: watchMs }).toBe(1);
});
